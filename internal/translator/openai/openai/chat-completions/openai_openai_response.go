// Package chat_completions provides passthrough response translation for OpenAI Chat Completions.
// It normalizes OpenAI-compatible SSE lines by stripping the "data:" prefix and dropping "[DONE]".
package chat_completions

import (
	"bytes"
	"context"
	"fmt"
	"time"

	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

type ConvertOpenAIResponseToOpenAIParams struct {
	LastMessageID   string
	LastModel       string
	LastCreated     int64
	SawToolCall     bool
	SawContent      bool
	SawFinishReason bool
}

// ConvertOpenAIResponseToOpenAI normalizes a single chunk of an OpenAI-compatible streaming response.
// If the chunk is an SSE "data:" line, the prefix is stripped and the remaining JSON payload is returned.
// The "[DONE]" marker yields no output, but may synthesize a final chunk with finish_reason if the
// upstream closed the stream without emitting one.
//
// Parameters:
//   - ctx: The context for the request, used for cancellation and timeout handling
//   - modelName: The name of the model being used for the response (unused in current implementation)
//   - rawJSON: The raw JSON response from the Gemini CLI API
//   - param: A pointer to a parameter object for maintaining state between calls
//
// Returns:
//   - [][]byte: A slice of JSON payload chunks in OpenAI format.
func ConvertOpenAIResponseToOpenAI(_ context.Context, _ string, originalRequestRawJSON, requestRawJSON, rawJSON []byte, param *any) [][]byte {
	if bytes.HasPrefix(rawJSON, []byte("data:")) {
		rawJSON = bytes.TrimSpace(rawJSON[5:])
	}

	// Initialize state parameter if needed
	var p *ConvertOpenAIResponseToOpenAIParams
	if param != nil {
		if *param == nil {
			*param = &ConvertOpenAIResponseToOpenAIParams{}
		}
		p = (*param).(*ConvertOpenAIResponseToOpenAIParams)
	}

	if bytes.Equal(rawJSON, []byte("[DONE]")) {
		if p != nil && !p.SawFinishReason {
			// Synthesize a final chunk with finish_reason to prevent OpenAI SDK from throwing
			// "Stream ended without finish_reason" (e.g. for NVIDIA GLM-5.1 or empty streams).
			msgID := p.LastMessageID
			if msgID == "" {
				msgID = fmt.Sprintf("chatcmpl-empty-%d", time.Now().UnixNano())
			}
			model := p.LastModel
			if model == "" {
				model = "unknown"
			}
			created := p.LastCreated
			if created == 0 {
				created = time.Now().Unix()
			}

			finishReason := "stop"
			if p.SawToolCall {
				finishReason = "tool_calls"
			}

			chunk := []byte(`{"id":"","object":"chat.completion.chunk","created":0,"model":"","choices":[{"index":0,"delta":{},"logprobs":null,"finish_reason":null}]}`)
			chunk, _ = sjson.SetBytes(chunk, "id", msgID)
			chunk, _ = sjson.SetBytes(chunk, "model", model)
			chunk, _ = sjson.SetBytes(chunk, "created", created)
			chunk, _ = sjson.SetBytes(chunk, "choices.0.finish_reason", finishReason)

			p.SawFinishReason = true
			return [][]byte{chunk}
		}
		return [][]byte{}
	}

	// Update state parameters from incoming chunk
	if p != nil {
		root := gjson.ParseBytes(rawJSON)
		if id := root.Get("id").String(); id != "" {
			p.LastMessageID = id
		}
		if model := root.Get("model").String(); model != "" {
			p.LastModel = model
		}
		if created := root.Get("created").Int(); created != 0 {
			p.LastCreated = created
		}

		// Inspect choices
		choices := root.Get("choices")
		if choices.Exists() && choices.IsArray() {
			choices.ForEach(func(_, choice gjson.Result) bool {
				// Check for tool calls
				if toolCalls := choice.Get("delta.tool_calls"); toolCalls.Exists() && toolCalls.IsArray() && len(toolCalls.Array()) > 0 {
					p.SawToolCall = true
				}
				// Check for content
				if content := choice.Get("delta.content"); content.Exists() && content.String() != "" {
					p.SawContent = true
				}
				// Check for finish_reason
				if finishReason := choice.Get("finish_reason"); finishReason.Exists() && finishReason.Type != gjson.Null && finishReason.String() != "" {
					p.SawFinishReason = true
				}
				return true
			})
		}
	}

	return [][]byte{rawJSON}
}

// ConvertOpenAIResponseToOpenAINonStream passes through a non-streaming OpenAI response.
//
// Parameters:
//   - ctx: The context for the request, used for cancellation and timeout handling
//   - modelName: The name of the model being used for the response
//   - rawJSON: The raw JSON response from the Gemini CLI API
//   - param: A pointer to a parameter object for the conversion
//
// Returns:
//   - []byte: The OpenAI-compatible JSON response.
func ConvertOpenAIResponseToOpenAINonStream(ctx context.Context, modelName string, originalRequestRawJSON, requestRawJSON, rawJSON []byte, param *any) []byte {
	return rawJSON
}
