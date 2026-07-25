// Package chat_completions provides passthrough response translation for OpenAI Chat Completions.
// It normalizes OpenAI-compatible SSE lines by stripping the "data:" prefix and dropping "[DONE]".
package chat_completions

import (
	"bytes"
	"context"

	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

// ConvertOpenAIResponseToOpenAIParams tracks streaming state so that a
// synthetic finish_reason chunk can be emitted when the upstream closes
// the stream without one (e.g. NVIDIA vLLM bug with glm-5.1).
type ConvertOpenAIResponseToOpenAIParams struct {
	SawToolCall  bool
	FinishReason string
	LastID       string
	LastModel    string
}

// ConvertOpenAIResponseToOpenAI normalizes a single chunk of an OpenAI-compatible streaming response.
// If the chunk is an SSE "data:" line, the prefix is stripped and the remaining JSON payload is returned.
// The "[DONE]" marker yields no output.
//
// Parameters:
//   - ctx: The context for the request, used for cancellation and timeout handling
//   - modelName: The name of the model being used for the response (unused in current implementation)
//   - rawJSON: The raw JSON response from the OpenAI API
//   - param: A pointer to a parameter object for maintaining state between calls
//
// Returns:
//   - [][]byte: A slice of JSON payload chunks in OpenAI format.
func ConvertOpenAIResponseToOpenAI(_ context.Context, _ string, originalRequestRawJSON, requestRawJSON, rawJSON []byte, param *any) [][]byte {
	if bytes.HasPrefix(rawJSON, []byte("data:")) {
		rawJSON = bytes.TrimSpace(rawJSON[5:])
	}

	// Lazily initialise state.
	if *param == nil {
		*param = &ConvertOpenAIResponseToOpenAIParams{}
	}
	state := (*param).(*ConvertOpenAIResponseToOpenAIParams)

	if bytes.Equal(rawJSON, []byte("[DONE]")) {
		// Stream ended. Synthesize finish_reason if upstream never sent one.
		if state.FinishReason == "" {
			reason := "stop"
			if state.SawToolCall {
				reason = "tool_calls"
			}
			synth := []byte(`{"id":"","object":"chat.completion.chunk","created":0,"model":"","choices":[{"index":0,"delta":{},"finish_reason":""}]}`)
			synth, _ = sjson.SetBytes(synth, "id", state.LastID)
			synth, _ = sjson.SetBytes(synth, "model", state.LastModel)
			synth, _ = sjson.SetBytes(synth, "choices.0.finish_reason", reason)
			return [][]byte{synth}
		}
		return [][]byte{}
	}

	// Track state from normal chunks.
	root := gjson.ParseBytes(rawJSON)
	if id := root.Get("id"); id.Exists() {
		state.LastID = id.String()
	}
	if model := root.Get("model"); model.Exists() {
		state.LastModel = model.String()
	}
	choices := root.Get("choices")
	if choices.Exists() && choices.IsArray() {
		for _, choice := range choices.Array() {
			if fr := choice.Get("finish_reason"); fr.Exists() && fr.Type != gjson.Null {
				state.FinishReason = fr.String()
			}
			if choice.Get("delta.tool_calls").Exists() {
				state.SawToolCall = true
			}
		}
	}

	return [][]byte{rawJSON}
}

// ConvertOpenAIResponseToOpenAINonStream passes through a non-streaming OpenAI response.
//
// Parameters:
//   - ctx: The context for the request, used for cancellation and timeout handling
//   - modelName: The name of the model being used for the response
//   - rawJSON: The raw JSON response from the OpenAI API
//   - param: A pointer to a parameter object for the conversion
//
// Returns:
//   - []byte: The OpenAI-compatible JSON response.
func ConvertOpenAIResponseToOpenAINonStream(ctx context.Context, modelName string, originalRequestRawJSON, requestRawJSON, rawJSON []byte, param *any) []byte {
	return rawJSON
}
