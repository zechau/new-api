// RunningHub workflow execution. The vendor exposes three task endpoints on
// one host: /task/openapi/create submits a run with the nodeInfoList that
// overrides ComfyUI node fields, /task/openapi/outputs doubles as the status
// query and the result endpoint, and /task/openapi/upload stores an input file.
// A driver hook can only describe one request, so uploads are out of reach:
// image, audio and video node inputs must already be stored and travel as the
// `api/xxx.jpg` fileName the upload endpoint returns.
//
// The business `code` is a status, not an error flag: 0 finished, 804 running,
// 813 queued, 805 failed. Only create treats a non-zero code as fatal, because
// a finished run is the only state in which outputs carries a result array.
const MODEL_PREFIX = "runninghub/workflow/";
const CREATE_PATH = "/task/openapi/create";
const OUTPUTS_PATH = "/task/openapi/outputs";
const CODE_RUNNING = 804;
const CODE_QUEUED = 813;
const CODE_FAILED = 805;
// ComfyUI node ids are the numeric keys of an exported api.json.
const NODE_ID = /^\d+$/;
// A workflow run rewrites a bounded set of nodes; the cap keeps one request
// from carrying an entire exported workflow.
const MAX_NODE_FIELDS = 64;
// Node field names the official integration treats as uploaded files.
const MEDIA_FIELDS = ["image", "audio", "video"];
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "jfif", "webp", "gif", "bmp", "avif"];
const VIDEO_EXTENSIONS = ["mp4", "webm", "mov", "mkv", "avi", "m4v"];
const AUDIO_EXTENSIONS = ["mp3", "wav", "ogg", "oga", "aac", "flac", "m4a"];
const MEDIA_TYPES = ["image", "video", "audio", "file"];
const ARTIFACT_ORDER = { image: 0, video: 1, audio: 2, file: 3 };

export const meta = {
  apiVersion: 1,
  key: "runninghub",
  name: "RunningHub",
  icon: "text:RH",
  website: "https://www.runninghub.cn/",
  description: {
    en: "RunningHub ComfyUI workflow execution with image, video, audio and file outputs",
    zh: "RunningHub ComfyUI 工作流执行，输出图片、视频、音频与文件",
  },
  version: "1.0.0",
  author: { name: "QuantumNous" },
  // Leave a type-61 channel's Base URL empty and the host copies this value.
  baseUrl: "https://www.runninghub.cn",
  // The vendor authenticates with an apiKey body field, not a bearer header.
  auth: "api_key",
  // The host matches model names exactly, so every workflow this plugin can run
  // is enumerated here. Adding one is a manifest edit plus an admin re-upload.
  models: ["runninghub/workflow/2103493450875359234", "runninghub/workflow/2011682329755918338"],
  fetchMode: "per_task",
  usageSchema: {
    // Output files whose media type is an image.
    image_count: {
      type: "number",
      unit: "count",
      unitLabel: { en: "image", zh: "张" },
      description: { en: "Image generation unit price", zh: "图片生成单价" },
    },
    // Output files whose media type is a video.
    video_count: {
      type: "number",
      unit: "count",
      unitLabel: { en: "video", zh: "个" },
      description: { en: "Video generation unit price", zh: "视频生成单价" },
    },
  },
  usageExamples: [
    { label: "1 image · 0 video", facts: { image_count: 1, video_count: 0 } },
    { label: "4 images · 0 video", facts: { image_count: 4, video_count: 0 } },
    { label: "0 image · 1 video", facts: { image_count: 0, video_count: 1 } },
  ],
  protocols: [{ name: "openai_responses", supports: ["stream", "sync", "background"] }, "openai_image", "openai_video"],
};

function trimmed(value) {
  return String(value === undefined || value === null ? "" : value).trim();
}

function objectOrEmpty(value, name) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error(name + " must be an object");
  return value;
}

function escapeAttribute(value) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// The workflow identity is the model name; there is no request field that may
// override it, so a workflow keeps its own price and never borrows another's.
function workflowId(model) {
  const name = trimmed(model);
  const id = name.indexOf(MODEL_PREFIX) === 0 ? trimmed(name.slice(MODEL_PREFIX.length)) : "";
  if (!NODE_ID.test(id)) throw new Error("model must be " + MODEL_PREFIX + "<workflowId>, for example runninghub/workflow/1980468315921559554");
  return id;
}

function channelKey(ctx) {
  const key = trimmed(ctx.apiKey);
  if (!key) throw new Error("the RunningHub channel key is empty");
  return key;
}

function upstreamMessage(body) {
  return trimmed(body.msg) || "code " + String(body.code);
}

// The documented result entries carry fileUrl; the other names are the
// spellings neighbouring ComfyUI deployments return for the same payload.
function outputUrl(entry) {
  return trimmed(entry.fileUrl) || trimmed(entry.file_url) || trimmed(entry.url);
}

// RunningHub reports a bare extension in fileType and no fileType at all for
// some node types, so the URL path decides when the field is not a media name.
function outputExtension(entry) {
  const declared = trimmed(entry.fileType).toLowerCase().replace(/^\./, "");
  if (declared && declared !== "input") return declared;
  const path = outputUrl(entry).split("?")[0].split("#")[0];
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "";
  return path.slice(dot + 1).toLowerCase();
}

function outputMedia(entry) {
  const extension = outputExtension(entry);
  if (MEDIA_TYPES.indexOf(extension) >= 0) return { type: extension, mimeType: "" };
  if (IMAGE_EXTENSIONS.indexOf(extension) >= 0)
    return { type: "image", mimeType: "image/" + (extension === "jpg" || extension === "jfif" ? "jpeg" : extension) };
  if (VIDEO_EXTENSIONS.indexOf(extension) >= 0) return { type: "video", mimeType: "video/" + extension };
  if (AUDIO_EXTENSIONS.indexOf(extension) >= 0)
    return { type: "audio", mimeType: "audio/" + (extension === "oga" ? "ogg" : extension) };
  return { type: "file", mimeType: "" };
}

// Successful outputs are an array of per-node result entries. An entry without
// a URL carries no artifact and never becomes a billed quantity.
function outputEntries(data) {
  const body = objectOrEmpty(data, "outputs response");
  const list = Array.isArray(body.data) ? body.data : [];
  const entries = [];
  const counters = { image: 0, video: 0, audio: 0, file: 0 };
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const url = outputUrl(item);
    if (!url) continue;
    const media = outputMedia(item);
    counters[media.type] += 1;
    const entry = { key: media.type + "-" + counters[media.type], url: url, type: media.type };
    if (media.mimeType) entry.mimeType = media.mimeType;
    entries.push(entry);
  }
  return entries;
}

function setNodeField(nodes, nodeId, fieldName, fieldValue) {
  for (const node of nodes) {
    if (node.nodeId === nodeId && node.fieldName === fieldName) {
      node.fieldValue = fieldValue;
      return;
    }
  }
  nodes.push({ nodeId: nodeId, fieldName: fieldName, fieldValue: fieldValue });
}

function nodeEntries(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("nodeInfoList must be an array");
  if (value.length > MAX_NODE_FIELDS) throw new Error("nodeInfoList accepts at most " + MAX_NODE_FIELDS + " entries");
  const nodes = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("nodeInfoList entries must be objects");
    const nodeId = trimmed(item.nodeId);
    if (!NODE_ID.test(nodeId)) throw new Error("nodeInfoList nodeId must be a ComfyUI node id such as \"6\"");
    const fieldName = trimmed(item.fieldName);
    if (!fieldName) throw new Error("nodeInfoList fieldName is required");
    if (item.fieldValue === undefined || item.fieldValue === null || typeof item.fieldValue === "object")
      throw new Error("nodeInfoList fieldValue must be a string, number or boolean");
    nodes.push({ nodeId: nodeId, fieldName: fieldName, fieldValue: String(item.fieldValue) });
  }
  return nodes;
}

function outputKind(request, params, fallback) {
  const declared = trimmed(params.outputKind === undefined ? request.outputKind : params.outputKind).toLowerCase();
  if (!declared) return fallback;
  if (declared !== "image" && declared !== "video") throw new Error("outputKind must be image or video");
  return declared;
}

function submissionAction(kind, nodes) {
  const hasMedia = nodes.some(function (node) {
    return MEDIA_FIELDS.indexOf(node.fieldName) >= 0;
  });
  if (kind === "video") return hasMedia ? "image_to_video" : "text_to_video";
  return hasMedia ? "image_to_image" : "text_to_image";
}

// One normalizer for every entry point. The decoders, buildSubmitRequest and
// extractUsage all call it, so a raw POST /v1/tasks/runninghub body and a
// decoded protocol body converge on the same canonical request and the hooks
// stay safe to run more than once.
function normalizeSubmission(requestBody, model, fallbackKind) {
  const request = objectOrEmpty(requestBody, "request body");
  const params = objectOrEmpty(request.params, "params");
  const nodes = nodeEntries(request.nodeInfoList === undefined ? params.nodeInfoList : request.nodeInfoList);
  const prompt = trimmed(request.prompt);
  if (prompt) {
    // ComfyUI text nodes have no common field or id across workflows, so the
    // caller names the target instead of the plugin guessing one.
    const nodeId = trimmed(params.textNodeId === undefined ? request.textNodeId : params.textNodeId);
    const fieldName = trimmed(params.textFieldName === undefined ? request.textFieldName : params.textFieldName) || "text";
    if (!NODE_ID.test(nodeId))
      throw new Error("prompt needs params.textNodeId, the id of the ComfyUI text node to write, or pass nodeInfoList instead");
    setNodeField(nodes, nodeId, fieldName, prompt);
  }
  if (!nodes.length) throw new Error("a workflow run needs nodeInfoList, or prompt together with params.textNodeId");
  const kind = outputKind(request, params, fallbackKind);
  return {
    model: trimmed(request.model) || trimmed(model),
    workflowId: workflowId(model),
    outputKind: kind,
    nodeInfoList: nodes,
    action: trimmed(request.action) || submissionAction(kind, nodes),
  };
}

// The host serves the vendor body on POST /v1/tasks/runninghub unchanged, so
// the surface decoders only lift the caller's node target out of params or
// metadata and name the output kind their surface implies.
function workflowRequestBody(ctx, request, prompt, kind) {
  const params = Object.assign({}, objectOrEmpty(request.metadata, "metadata"), objectOrEmpty(request.params, "params"));
  const body = { model: trimmed(ctx.model), prompt: prompt, outputKind: kind };
  // params and metadata win over a flat field, so a multipart form, a raw JSON
  // body and the wrapped form all name the same node.
  for (const key of ["outputKind", "nodeInfoList", "textNodeId", "textFieldName", "action"]) {
    const value = params[key] === undefined ? request[key] : params[key];
    if (value !== undefined) body[key] = value;
  }
  return body;
}

function responsesPrompt(request) {
  const input = request.input;
  const texts = [];
  if (typeof input === "string") texts.push(input);
  else if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string") {
        texts.push(item);
        continue;
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const content = item.content === undefined ? [item] : Array.isArray(item.content) ? item.content : [item.content];
      for (const part of content) {
        if (typeof part === "string") texts.push(part);
        else if (part && typeof part === "object" && (part.type === "input_text" || part.type === "text") && typeof part.text === "string")
          texts.push(part.text);
      }
    }
  } else if (input !== undefined) throw new Error("input must be a string or array");
  return texts
    .filter(function (text) {
      return trimmed(text);
    })
    .join("\n");
}

function promptTipsErrors(promptTips) {
  if (promptTips === undefined || promptTips === null) return "";
  let tips = promptTips;
  if (typeof tips === "string") {
    if (!trimmed(tips)) return "";
    try {
      tips = JSON.parse(tips);
    } catch (e) {
      return "";
    }
  }
  if (!tips || typeof tips !== "object" || Array.isArray(tips)) return "";
  const errors = objectOrEmpty(tips.node_errors, "promptTips.node_errors");
  const parts = [];
  for (const nodeId of Object.keys(errors)) {
    const detail = errors[nodeId];
    const message =
      detail && typeof detail === "object" && !Array.isArray(detail)
        ? trimmed(detail.exception_message) || trimmed(detail.errors) || "invalid inputs"
        : trimmed(detail) || "invalid inputs";
    parts.push("node " + nodeId + ": " + message);
  }
  return parts.join("; ");
}

function failureReason(body) {
  const data = objectOrEmpty(body.data, "outputs data");
  const failed = objectOrEmpty(data.failedReason, "failedReason");
  const node = trimmed(failed.node_name);
  const message = trimmed(failed.exception_message);
  if (node && message) return "node " + node + " failed: " + message;
  if (message) return message;
  if (node) return "node " + node + " failed";
  return upstreamMessage(body);
}

// Media answers use the host-projected artifact URLs so an upstream CDN link
// is never handed to a client; task.data keeps the raw snapshot for billing.
function responsesOutputText(ctx) {
  const artifacts = objectOrEmpty(ctx.artifacts, "artifacts");
  const keys = Object.keys(artifacts).sort(function (left, right) {
    const order = ARTIFACT_ORDER[trimmed(artifacts[left].type) || "file"] - ARTIFACT_ORDER[trimmed(artifacts[right].type) || "file"];
    return order !== 0 ? order : left.localeCompare(right);
  });
  const parts = [];
  for (const key of keys) {
    const artifact = artifacts[key];
    const url = trimmed(artifact && artifact.url);
    if (!url) continue;
    const type = trimmed(artifact.type) || "file";
    if (type === "image") parts.push("![Image " + key + "](<" + url + ">)");
    else if (type === "video") parts.push('<video controls src="' + escapeAttribute(url) + '"></video>');
    else parts.push("[Download " + key + "](<" + url + ">)");
  }
  if (!parts.length) throw new Error("task artifact is unavailable");
  return parts.join("\n\n");
}

export function buildSubmitRequest(ctx) {
  const submission = normalizeSubmission(ctx.requestBody, ctx.upstreamModel || ctx.model, "image");
  return {
    url: ctx.baseUrl + CREATE_PATH,
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: { apiKey: channelKey(ctx), workflowId: submission.workflowId, nodeInfoList: submission.nodeInfoList },
    action: submission.action,
  };
}

export function parseSubmitResponse(_ctx, resp) {
  const body = resp && resp.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid RunningHub submit response");
  if (Number(body.code) !== 0) throw new Error("RunningHub rejected the workflow run: " + upstreamMessage(body));
  const data = objectOrEmpty(body.data, "submit data");
  const taskId = trimmed(data.taskId === undefined ? data.task_id : data.taskId);
  if (!taskId) throw new Error("RunningHub returned no taskId");
  // A workflow that reports node errors will not run; failing here spares the
  // caller a full poll cycle before the same failure surfaces.
  const nodeErrors = promptTipsErrors(data.promptTips);
  if (nodeErrors) throw new Error("RunningHub rejected the workflow inputs: " + nodeErrors);
  return { taskId: taskId, taskData: body };
}

// The reservation knows only which output kind the caller asked for. The
// completion facts carry the real per-media counts, so a workflow that returns
// more files than requested settles up and one that returns none keeps the
// reserved quantity. A zero is never returned here because legacy per-call
// pricing multiplies by every ratio and rejects a non-positive one.
export function extractUsage(ctx) {
  const submission = normalizeSubmission(ctx.requestBody, ctx.upstreamModel || ctx.model, "image");
  return submission.outputKind === "video" ? { video_count: 1 } : { image_count: 1 };
}

export function extractUsageOnComplete(_task, _result, body) {
  const entries = outputEntries(body);
  if (!entries.length) return null;
  let images = 0;
  let videos = 0;
  for (const entry of entries) {
    if (entry.type === "video") videos += 1;
    else if (entry.type === "image") images += 1;
  }
  return { image_count: images, video_count: videos };
}

export function buildQueryRequest(ctx) {
  const taskId = trimmed(ctx.taskId);
  if (!taskId) throw new Error("missing RunningHub task id");
  return {
    url: ctx.baseUrl + OUTPUTS_PATH,
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: { apiKey: channelKey(ctx), taskId: taskId },
  };
}

export function parseTaskResult(_ctx, body, _response) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { status: "UNKNOWN", reason: "invalid RunningHub outputs response" };
  const code = Number(body.code);
  if (code === 0) {
    const entries = outputEntries(body);
    if (!entries.length) return { status: "FAILURE", reason: "the workflow finished without producing an output file" };
    return { status: "SUCCESS", progress: "100%", url: entries[0].url };
  }
  if (code === CODE_RUNNING) return { status: "IN_PROGRESS" };
  if (code === CODE_QUEUED) return { status: "QUEUED" };
  if (code === CODE_FAILED) return { status: "FAILURE", reason: failureReason(body) };
  return { status: "UNKNOWN", reason: "unexpected RunningHub code " + String(body.code) + ": " + upstreamMessage(body) };
}

export function listArtifacts(task) {
  if (task.status !== "SUCCESS") return [];
  return outputEntries(task.data).map(function (entry) {
    const artifact = { key: entry.key, type: entry.type };
    if (entry.mimeType) artifact.mimeType = entry.mimeType;
    return artifact;
  });
}

// The result host is a CDN, not the channel base URL. A credentialless
// descriptor keeps the channel key away from it and needs no allowedHosts entry.
export function buildContentRequest(ctx) {
  for (const entry of outputEntries(ctx.data)) {
    if (entry.key === ctx.artifactKey) return { url: entry.url, method: ctx.clientRequest.method, credentialless: true };
  }
  throw new Error("artifact_not_found");
}

export const protocols = {
  openai_responses: {
    decodeRequest: function (ctx) {
      if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
      const request = ctx.body.value;
      if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("request body must be an object");
      const prompt = trimmed(request.prompt) || responsesPrompt(request);
      const submission = normalizeSubmission(
        workflowRequestBody(ctx, request, prompt, "image"),
        ctx.upstreamModel || ctx.model,
        "image"
      );
      return { kind: "submit", model: trimmed(ctx.model), action: submission.action, requestBody: submission };
    },
    renderEvents: function (ctx, task, previousState) {
      const status = String(task.status || "UNKNOWN").toUpperCase();
      const state = { status: status, progress: null };
      if (status === "SUCCESS") {
        const events = previousState && previousState.status === status ? [] : [{ type: "output", data: responsesOutputText(ctx) }];
        return { events: events, state: state, done: true };
      }
      if (status === "FAILURE")
        return { events: [{ type: "error", code: "task_failed", message: task.fail_reason || "task failed" }], state: state, done: true };
      if (previousState && previousState.status === status) return { events: [], state: state, done: false };
      return { events: [{ type: "progress", message: status.toLowerCase() }], state: state, done: false };
    },
    renderFinal: function (ctx, task) {
      return {
        output: [
          {
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: responsesOutputText(ctx), annotations: [], logprobs: [] }],
          },
        ],
        metadata: { vendor: "runninghub" },
      };
    },
  },
  // OpenAI Images API. The host pins ctx.model, polls the task to a terminal
  // state inside the request and owns response_format, so a workflow run is
  // billed on the output files it actually produced rather than on n.
  openai_image: {
    decodeRequest: function (ctx) {
      let request;
      if (ctx.body && ctx.body.kind === "json") {
        request = ctx.body.value;
        if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("request body must be an object");
      } else if (ctx.body && ctx.body.kind === "multipart") {
        if ((ctx.body.files || []).length)
          throw new Error("a workflow run cannot upload files; store the file through RunningHub first and pass it as an api/... nodeInfoList fieldValue");
        request = {};
        const fields = ctx.body.fields || {};
        for (const name of Object.keys(fields)) {
          if (fields[name].length > 1) throw new Error(name + " must be provided once");
          request[name] = fields[name][0];
        }
      } else throw new Error("JSON or multipart body required");
      if (request.n !== undefined && request.n !== null) {
        const n = Number(request.n);
        if (!Number.isInteger(n) || n < 1) throw new Error("n must be a positive integer");
        if (n > 1) throw new Error("a RunningHub workflow run returns one output set; n must be 1");
      }
      if (request.response_format !== undefined && request.response_format !== "url" && request.response_format !== "b64_json")
        throw new Error("response_format must be url or b64_json");
      const submission = normalizeSubmission(workflowRequestBody(ctx, request, trimmed(request.prompt), "image"), ctx.upstreamModel || ctx.model, "image");
      return { kind: "submit", model: trimmed(ctx.model), action: submission.action, requestBody: submission };
    },
    render: function (_ctx, task) {
      const data = [];
      for (const entry of outputEntries(task.data)) {
        if (entry.type === "image") data.push({ url: entry.url });
      }
      if (!data.length) throw new Error("the workflow produced no image output; use /v1/videos for a workflow that returns video");
      return { created: task.created_at, data: data };
    },
  },
  openai_video: {
    decodeRequest: function (ctx) {
      if (!ctx.body || ctx.body.kind !== "json") throw new Error("JSON body required");
      const request = ctx.body.value;
      if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("request body must be an object");
      const submission = normalizeSubmission(workflowRequestBody(ctx, request, trimmed(request.prompt), "video"), ctx.upstreamModel || ctx.model, "video");
      return { kind: "submit", model: trimmed(ctx.model), action: submission.action, requestBody: submission };
    },
    // The deliverable is served from /v1/videos/:task_id/content, so the vendor
    // CDN link stays out of the response body. The host owns the public task's
    // identity, status, progress and timestamps, which leaves the failure
    // detail as the only extension worth returning.
    render: function (_ctx, task) {
      if (String(task.status || "").toUpperCase() !== "FAILURE") return {};
      return { error: { code: "task_failed", message: task.fail_reason || "task failed" } };
    },
  },
};
