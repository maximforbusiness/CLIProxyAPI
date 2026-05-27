package thinking_test

import (
	"testing"

	"github.com/router-for-me/CLIProxyAPI/v7/internal/registry"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/thinking"
	_ "github.com/router-for-me/CLIProxyAPI/v7/internal/thinking/provider/claude"
	_ "github.com/router-for-me/CLIProxyAPI/v7/internal/thinking/provider/openai"
	"github.com/tidwall/gjson"
)

func TestApplyThinking_UserDefinedClaudePreservesAdaptiveLevel(t *testing.T) {
	reg := registry.GetGlobalRegistry()
	clientID := "test-user-defined-claude-" + t.Name()
	modelID := "custom-claude-4-6"
	reg.RegisterClient(clientID, "claude", []*registry.ModelInfo{{ID: modelID, UserDefined: true}})
	t.Cleanup(func() {
		reg.UnregisterClient(clientID)
	})

	tests := []struct {
		name  string
		model string
		body  []byte
	}{
		{
			name:  "claude adaptive effort body",
			model: modelID,
			body:  []byte(`{"thinking":{"type":"adaptive"},"output_config":{"effort":"high"}}`),
		},
		{
			name:  "suffix level",
			model: modelID + "(high)",
			body:  []byte(`{}`),
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			out, err := thinking.ApplyThinking(tt.body, tt.model, "openai", "claude", "claude")
			if err != nil {
				t.Fatalf("ApplyThinking() error = %v", err)
			}
			if got := gjson.GetBytes(out, "thinking.type").String(); got != "adaptive" {
				t.Fatalf("thinking.type = %q, want %q, body=%s", got, "adaptive", string(out))
			}
			if got := gjson.GetBytes(out, "output_config.effort").String(); got != "high" {
				t.Fatalf("output_config.effort = %q, want %q, body=%s", got, "high", string(out))
			}
			if gjson.GetBytes(out, "thinking.budget_tokens").Exists() {
				t.Fatalf("thinking.budget_tokens should be removed, body=%s", string(out))
			}
		})
	}
}

func TestApplyThinking_UserDefinedOpenAICompatClampsXHighToHigh(t *testing.T) {
	reg := registry.GetGlobalRegistry()
	clientID := "test-user-defined-openai-compat-" + t.Name()
	modelID := "custom-openai-compat-model"
	reg.RegisterClient(clientID, "nvidia", []*registry.ModelInfo{{ID: modelID, UserDefined: true}})
	t.Cleanup(func() {
		reg.UnregisterClient(clientID)
	})

	out, err := thinking.ApplyThinking(
		[]byte(`{"model":"custom-openai-compat-model","messages":[{"role":"user","content":"hi"}]}`),
		modelID+"(xhigh)",
		"openai",
		"openai",
		"nvidia",
	)
	if err != nil {
		t.Fatalf("ApplyThinking() error = %v", err)
	}
	if got := gjson.GetBytes(out, "reasoning_effort").String(); got != "high" {
		t.Fatalf("reasoning_effort = %q, want %q, body=%s", got, "high", string(out))
	}
}

func TestApplyThinking_UserDefinedOpenAIKeepsXHigh(t *testing.T) {
	reg := registry.GetGlobalRegistry()
	clientID := "test-user-defined-openai-" + t.Name()
	modelID := "custom-openai-model"
	reg.RegisterClient(clientID, "openai", []*registry.ModelInfo{{ID: modelID, UserDefined: true}})
	t.Cleanup(func() {
		reg.UnregisterClient(clientID)
	})

	out, err := thinking.ApplyThinking(
		[]byte(`{"model":"custom-openai-model","messages":[{"role":"user","content":"hi"}]}`),
		modelID+"(xhigh)",
		"openai",
		"openai",
		"openai",
	)
	if err != nil {
		t.Fatalf("ApplyThinking() error = %v", err)
	}
	if got := gjson.GetBytes(out, "reasoning_effort").String(); got != "xhigh" {
		t.Fatalf("reasoning_effort = %q, want %q, body=%s", got, "xhigh", string(out))
	}
}
