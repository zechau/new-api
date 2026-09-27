package plugins_test

import (
	"strings"
	"testing"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/pkg/jsplugin"
	builtinplugins "github.com/QuantumNous/new-api/plugins"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestRunningHubWorkflowProtocol(t *testing.T) {
	source, err := builtinplugins.Source("runninghub")
	require.NoError(t, err)
	registry := jsplugin.NewRegistry()
	plugin, err := registry.RegisterFactory(source, jsplugin.Options{Key: "runninghub"})
	require.NoError(t, err)

	// The manifest is the single source of truth for which workflows the plugin
	// runs, so the expectations below follow it instead of pinning an id that
	// would go stale the next time a workflow is added.
	require.NotEmpty(t, plugin.Meta.Models)
	model := plugin.Meta.Models[0]
	workflowID := strings.TrimPrefix(model, "runninghub/workflow/")
	require.NotEqual(t, model, workflowID, "every declared model must use the runninghub/workflow/<workflowId> shape")

	call := func(t *testing.T, hook string, args ...any) map[string]any {
		t.Helper()
		value, callErr := plugin.Engine.Call(t.Context(), hook, args...)
		require.NoError(t, callErr, hook)
		encoded, marshalErr := common.Marshal(value)
		require.NoError(t, marshalErr)
		var decoded map[string]any
		require.NoError(t, common.Unmarshal(encoded, &decoded))
		return decoded
	}
	callList := func(t *testing.T, hook string, args ...any) []any {
		t.Helper()
		value, callErr := plugin.Engine.Call(t.Context(), hook, args...)
		require.NoError(t, callErr, hook)
		encoded, marshalErr := common.Marshal(value)
		require.NoError(t, marshalErr)
		var decoded []any
		require.NoError(t, common.Unmarshal(encoded, &decoded))
		return decoded
	}
	callProtocol := func(t *testing.T, hook string, args ...any) map[string]any {
		t.Helper()
		value, callErr := plugin.Engine.CallPath(t.Context(), "protocols", []string{"openai_responses", hook}, args...)
		require.NoError(t, callErr, hook)
		encoded, marshalErr := common.Marshal(value)
		require.NoError(t, marshalErr)
		var decoded map[string]any
		require.NoError(t, common.Unmarshal(encoded, &decoded))
		return decoded
	}
	callImageProtocol := func(t *testing.T, hook string, args ...any) map[string]any {
		t.Helper()
		value, callErr := plugin.Engine.CallPath(t.Context(), "protocols", []string{"openai_image", hook}, args...)
		require.NoError(t, callErr, hook)
		encoded, marshalErr := common.Marshal(value)
		require.NoError(t, marshalErr)
		var decoded map[string]any
		require.NoError(t, common.Unmarshal(encoded, &decoded))
		return decoded
	}

	driverContext := map[string]any{
		"action":        "text_to_image",
		"baseUrl":       "https://www.runninghub.cn",
		"apiKey":        "rh-key",
		"authHeader":    "rh-key",
		"model":         model,
		"upstreamModel": model,
		"publicTaskId":  "task-public",
		"requestBody": map[string]any{
			"model":  model,
			"prompt": "1 girl in classroom",
			"params": map[string]any{
				"textNodeId": "6",
				"nodeInfoList": []any{
					map[string]any{"nodeId": "10", "fieldName": "image", "fieldValue": "api/xxx.jpg"},
					map[string]any{"nodeId": "11", "fieldName": "seed", "fieldValue": 456123987},
				},
			},
		},
	}

	t.Run("submits the nodeInfoList and the channel key as a body field", func(t *testing.T) {
		descriptor := call(t, "buildSubmitRequest", driverContext)
		assert.Equal(t, "https://www.runninghub.cn/task/openapi/create", descriptor["url"])
		assert.Equal(t, "POST", descriptor["method"])
		headers, ok := descriptor["headers"].(map[string]any)
		require.True(t, ok)
		assert.Equal(t, "application/json", headers["Content-Type"])
		// The vendor authenticates with a body field, never a bearer header.
		assert.NotContains(t, headers, "Authorization")
		assert.Equal(t, map[string]any{
			"apiKey":     "rh-key",
			"workflowId": workflowID,
			"nodeInfoList": []any{
				map[string]any{"nodeId": "10", "fieldName": "image", "fieldValue": "api/xxx.jpg"},
				map[string]any{"nodeId": "11", "fieldName": "seed", "fieldValue": "456123987"},
				map[string]any{"nodeId": "6", "fieldName": "text", "fieldValue": "1 girl in classroom"},
			},
		}, descriptor["body"])
		assert.Equal(t, "image_to_image", descriptor["action"])
	})

	t.Run("queries the combined status and result endpoint", func(t *testing.T) {
		query := call(t, "buildQueryRequest", map[string]any{
			"taskId": "1980471280073846785", "publicTaskId": "task-public",
			"model": model, "upstreamModel": model,
			"baseUrl": "https://www.runninghub.cn", "apiKey": "rh-key", "data": nil, "state": nil,
		})
		assert.Equal(t, "https://www.runninghub.cn/task/openapi/outputs", query["url"])
		assert.Equal(t, map[string]any{"apiKey": "rh-key", "taskId": "1980471280073846785"}, query["body"])
	})

	t.Run("rejects a model that names no workflow", func(t *testing.T) {
		_, callErr := plugin.Engine.Call(t.Context(), "buildSubmitRequest", map[string]any{
			"action": "text_to_image", "baseUrl": "https://www.runninghub.cn", "apiKey": "rh-key",
			"model": "runninghub-workflow", "upstreamModel": "runninghub-workflow", "publicTaskId": "task-public",
			"requestBody": map[string]any{"prompt": "a cat", "params": map[string]any{"textNodeId": "6"}},
		})
		require.ErrorContains(t, callErr, "model must be runninghub/workflow/<workflowId>")
	})

	t.Run("requires an explicit node target for a prompt", func(t *testing.T) {
		_, callErr := plugin.Engine.Call(t.Context(), "buildSubmitRequest", map[string]any{
			"action": "text_to_image", "baseUrl": "https://www.runninghub.cn", "apiKey": "rh-key",
			"model": model, "upstreamModel": model, "publicTaskId": "task-public",
			"requestBody": map[string]any{"prompt": "a cat"},
		})
		require.ErrorContains(t, callErr, "params.textNodeId")

		_, callErr = plugin.Engine.Call(t.Context(), "buildSubmitRequest", map[string]any{
			"action": "text_to_image", "baseUrl": "https://www.runninghub.cn", "apiKey": "rh-key",
			"model": model, "upstreamModel": model, "publicTaskId": "task-public",
			"requestBody": map[string]any{"nodeInfoList": []any{map[string]any{"nodeId": "x", "fieldName": "text", "fieldValue": "a cat"}}},
		})
		require.ErrorContains(t, callErr, "nodeId must be a ComfyUI node id")
	})

	t.Run("fails a submit that RunningHub already reports as invalid", func(t *testing.T) {
		_, callErr := plugin.Engine.Call(t.Context(), "parseSubmitResponse", driverContext, map[string]any{
			"statusCode": 200, "headers": map[string]any{},
			"body": map[string]any{"code": 0, "msg": "success", "data": map[string]any{
				"taskId":      "1980471280073846785",
				"promptTips":  `{"node_errors":{"3":{"exception_message":"value is not a list"}}}`,
			}},
		})
		require.ErrorContains(t, callErr, "node 3: value is not a list")

		parsed := call(t, "parseSubmitResponse", driverContext, map[string]any{
			"statusCode": 200, "headers": map[string]any{},
			"body": map[string]any{"code": 0, "msg": "success", "data": map[string]any{
				"taskId":     "1980471280073846785",
				"promptTips": `{"node_errors":{}}`,
			}},
		})
		assert.Equal(t, "1980471280073846785", parsed["taskId"])
	})

	t.Run("maps every documented outputs code", func(t *testing.T) {
		for _, testCase := range []struct {
			name       string
			body       map[string]any
			wantStatus string
			wantReason string
		}{
			{
				name: "success returns the first fileUrl",
				body: map[string]any{"code": 0, "msg": "success", "data": []any{
					map[string]any{"fileUrl": "https://rh-images.example/a.png", "fileType": "png", "taskCostTime": "35", "nodeId": "17"},
					map[string]any{"fileUrl": "https://rh-images.example/b.png", "fileType": "png"},
				}},
				wantStatus: "SUCCESS",
			},
			{
				name:       "running",
				body:       map[string]any{"code": 804, "msg": "running", "data": nil},
				wantStatus: "IN_PROGRESS",
			},
			{
				name:       "queued",
				body:       map[string]any{"code": 813, "msg": "queued"},
				wantStatus: "QUEUED",
			},
			{
				name: "failed names the node and its exception",
				body: map[string]any{"code": 805, "msg": "failed", "data": map[string]any{"failedReason": map[string]any{
					"node_name": "SaveImage", "exception_message": "'str' object has no attribute 'shape'",
				}}},
				wantStatus: "FAILURE",
				wantReason: "node SaveImage failed: 'str' object has no attribute 'shape'",
			},
			{
				name:       "finished without an output file",
				body:       map[string]any{"code": 0, "msg": "success", "data": []any{map[string]any{"nodeId": "17"}}},
				wantStatus: "FAILURE",
				wantReason: "the workflow finished without producing an output file",
			},
			{
				// An unrecognized code must stay UNKNOWN so the host counts a
				// poll failure instead of treating the task as still running.
				name:       "unknown code",
				body:       map[string]any{"code": 999, "msg": "gateway busy"},
				wantStatus: "UNKNOWN",
				wantReason: "unexpected RunningHub code 999: gateway busy",
			},
		} {
			t.Run(testCase.name, func(t *testing.T) {
				result := call(t, "parseTaskResult", driverContext, testCase.body, map[string]any{"status": 200, "headers": map[string]any{}})
				assert.Equal(t, testCase.wantStatus, result["status"])
				if testCase.wantReason != "" {
					assert.Equal(t, testCase.wantReason, result["reason"])
				}
				if testCase.wantStatus == "SUCCESS" {
					assert.Equal(t, "https://rh-images.example/a.png", result["url"])
				}
			})
		}
	})

	successBody := map[string]any{"code": 0, "msg": "success", "data": []any{
		map[string]any{"fileUrl": "https://rh-images.example/a.png", "fileType": "png"},
		map[string]any{"fileUrl": "https://rh-images.example/b.jpg?signature=vendor"},
		map[string]any{"fileUrl": "https://rh-images.example/clip.mp4"},
		map[string]any{"fileUrl": "https://rh-images.example/voice.mp3", "fileType": "mp3"},
		map[string]any{"fileUrl": "https://rh-images.example/data.json", "fileType": "json"},
		map[string]any{"nodeId": "17"},
	}}

	t.Run("settles the output counts by media type", func(t *testing.T) {
		facts := call(t, "extractUsageOnComplete", map[string]any{"taskId": "tid"}, map[string]any{"status": "SUCCESS"}, successBody)
		assert.Equal(t, map[string]any{"image_count": float64(2), "video_count": float64(1)}, facts)
	})

	t.Run("projects one artifact per output file and serves it credentialless", func(t *testing.T) {
		assert.Equal(t, []any{
			map[string]any{"key": "image-1", "type": "image", "mimeType": "image/png"},
			map[string]any{"key": "image-2", "type": "image", "mimeType": "image/jpeg"},
			map[string]any{"key": "video-1", "type": "video", "mimeType": "video/mp4"},
			map[string]any{"key": "audio-1", "type": "audio", "mimeType": "audio/mp3"},
			map[string]any{"key": "file-1", "type": "file"},
		}, callList(t, "listArtifacts", map[string]any{
			"taskId": "tid", "status": "SUCCESS", "action": "text_to_image", "producerVersion": "1.0.0", "data": successBody,
		}))

		content := call(t, "buildContentRequest", map[string]any{
			"artifactKey": "image-2", "upstreamTaskId": "tid", "data": successBody,
			"baseUrl": "https://www.runninghub.cn", "apiKey": "rh-key",
			"clientRequest": map[string]any{"method": "GET", "headers": map[string]any{}},
		})
		assert.Equal(t, "https://rh-images.example/b.jpg?signature=vendor", content["url"])
		assert.Equal(t, "GET", content["method"])
		assert.Equal(t, true, content["credentialless"])

		_, callErr := plugin.Engine.Call(t.Context(), "buildContentRequest", map[string]any{
			"artifactKey": "image-9", "upstreamTaskId": "tid", "data": successBody,
			"baseUrl": "https://www.runninghub.cn", "apiKey": "rh-key",
			"clientRequest": map[string]any{"method": "GET", "headers": map[string]any{}},
		})
		require.ErrorContains(t, callErr, "artifact_not_found")
	})

	t.Run("reserves only the requested output kind", func(t *testing.T) {
		assert.Equal(t, map[string]any{"image_count": float64(1)},
			call(t, "extractUsage", map[string]any{
				"model": model, "upstreamModel": model,
				"action": "text_to_image", "usagePurpose": "billing_ratios", "requestBody": driverContext["requestBody"],
			}))
		videoRequest := map[string]any{
			"model": model, "upstreamModel": model, "action": "text_to_video",
			"requestBody": map[string]any{"prompt": "a cat", "outputKind": "video", "params": map[string]any{"textNodeId": "6"}},
		}
		assert.Equal(t, map[string]any{"video_count": float64(1)},
			call(t, "extractUsage", map[string]any{"usagePurpose": "facts",
				"model": videoRequest["model"], "upstreamModel": videoRequest["upstreamModel"],
				"action": videoRequest["action"], "requestBody": videoRequest["requestBody"]}))
	})

	t.Run("decodes the image surface and renders its output entries", func(t *testing.T) {
		decoded := callImageProtocol(t, "decodeRequest", map[string]any{
			"model": model, "operation": "generate",
			"body": map[string]any{"kind": "json", "value": map[string]any{
				"model": model, "prompt": "1 girl in classroom", "n": float64(1),
				"params": map[string]any{"textNodeId": "6"},
			}},
		})
		assert.Equal(t, "submit", decoded["kind"])
		assert.Equal(t, model, decoded["model"])
		assert.Equal(t, "text_to_image", decoded["action"])
		requestBody, ok := decoded["requestBody"].(map[string]any)
		require.True(t, ok)
		assert.Equal(t, workflowID, requestBody["workflowId"])
		assert.Equal(t, "image", requestBody["outputKind"])
		assert.Equal(t, []any{map[string]any{"nodeId": "6", "fieldName": "text", "fieldValue": "1 girl in classroom"}}, requestBody["nodeInfoList"])

		_, callErr := plugin.Engine.CallPath(t.Context(), "protocols", []string{"openai_image", "decodeRequest"}, map[string]any{
			"model": model, "operation": "generate",
			"body": map[string]any{"kind": "json", "value": map[string]any{
				"model": model, "prompt": "a cat", "n": float64(4), "params": map[string]any{"textNodeId": "6"},
			}},
		})
		require.ErrorContains(t, callErr, "n must be 1")

		rendered := callImageProtocol(t, "render", map[string]any{"model": model}, map[string]any{
			"task_id": "task-public", "status": "SUCCESS", "created_at": 10, "data": successBody,
		})
		assert.Equal(t, float64(10), rendered["created"])
		assert.Equal(t, []any{
			map[string]any{"url": "https://rh-images.example/a.png"},
			map[string]any{"url": "https://rh-images.example/b.jpg?signature=vendor"},
		}, rendered["data"])
	})

	t.Run("accepts a flat node target from a form and a raw body", func(t *testing.T) {
		wantNodes := []any{map[string]any{"nodeId": "6", "fieldName": "text", "fieldValue": "a cat"}}
		form := callImageProtocol(t, "decodeRequest", map[string]any{
			"model": model, "upstreamModel": model,
			"body": map[string]any{"kind": "multipart", "files": []any{}, "fields": map[string]any{
				"prompt": []any{"a cat"}, "textNodeId": []any{"6"}, "n": []any{"1"},
			}},
		})
		assert.Equal(t, wantNodes, form["requestBody"].(map[string]any)["nodeInfoList"])

		raw := callImageProtocol(t, "decodeRequest", map[string]any{
			"model": model, "upstreamModel": model,
			"body": map[string]any{"kind": "json", "value": map[string]any{
				"model": model, "prompt": "a cat", "textNodeId": "6",
				"params": map[string]any{"textNodeId": "9"},
			}},
		})
		// A wrapped params value wins over the flat field so both spellings
		// resolve to one node instead of silently disagreeing.
		assert.Equal(t, []any{map[string]any{"nodeId": "9", "fieldName": "text", "fieldValue": "a cat"}},
			raw["requestBody"].(map[string]any)["nodeInfoList"])

		_, callErr := plugin.Engine.CallPath(t.Context(), "protocols", []string{"openai_image", "decodeRequest"}, map[string]any{
			"model": model, "upstreamModel": model,
			"body": map[string]any{"kind": "multipart", "files": []any{map[string]any{"ref": "request_file:image", "filename": "a.png"}}, "fields": map[string]any{}},
		})
		require.ErrorContains(t, callErr, "cannot upload files")
	})

	t.Run("renders a Responses reply from host artifacts only", func(t *testing.T) {
		protocolContext := map[string]any{
			"model": model, "stream": true,
			"artifacts": map[string]any{
				"video-1": map[string]any{"key": "video-1", "type": "video", "url": "https://gateway.example/artifacts/clip"},
				"image-1": map[string]any{"key": "image-1", "type": "image", "url": "https://gateway.example/artifacts/a.png"},
			},
		}
		task := map[string]any{"task_id": "task-public", "status": "SUCCESS", "data": successBody}
		final := callProtocol(t, "renderFinal", protocolContext, task)
		encoded, marshalErr := common.Marshal(final)
		require.NoError(t, marshalErr)
		text := string(encoded)
		assert.Contains(t, text, "https://gateway.example/artifacts/a.png")
		assert.Contains(t, text, "https://gateway.example/artifacts/clip")
		assert.NotContains(t, text, "rh-images.example")

		_, callErr := plugin.Engine.CallPath(t.Context(), "protocols", []string{"openai_responses", "renderFinal"},
			map[string]any{"model": model}, task)
		require.ErrorContains(t, callErr, "task artifact is unavailable")
	})
}
