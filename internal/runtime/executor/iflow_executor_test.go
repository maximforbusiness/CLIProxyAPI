package executor

import (
	"net/http"
	"testing"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v6/internal/thinking"
)

func TestIFlowExecutorParseSuffix(t *testing.T) {
	tests := []struct {
		name      string
		model     string
		wantBase  string
		wantLevel string
	}{
		{"no suffix", "glm-4", "glm-4", ""},
		{"glm with suffix", "glm-4.1-flash(high)", "glm-4.1-flash", "high"},
		{"minimax no suffix", "minimax-m2", "minimax-m2", ""},
		{"minimax with suffix", "minimax-m2.1(medium)", "minimax-m2.1", "medium"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := thinking.ParseSuffix(tt.model)
			if result.ModelName != tt.wantBase {
				t.Errorf("ParseSuffix(%q).ModelName = %q, want %q", tt.model, result.ModelName, tt.wantBase)
			}
		})
	}
}

func TestPreserveReasoningContentInMessages(t *testing.T) {
	tests := []struct {
		name  string
		input []byte
		want  []byte // nil means output should equal input
	}{
		{
			"non-glm model passthrough",
			[]byte(`{"model":"gpt-4","messages":[]}`),
			nil,
		},
		{
			"glm model with empty messages",
			[]byte(`{"model":"glm-4","messages":[]}`),
			nil,
		},
		{
			"glm model preserves existing reasoning_content",
			[]byte(`{"model":"glm-4","messages":[{"role":"assistant","content":"hi","reasoning_content":"thinking..."}]}`),
			nil,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := preserveReasoningContentInMessages(tt.input)
			want := tt.want
			if want == nil {
				want = tt.input
			}
			if string(got) != string(want) {
				t.Errorf("preserveReasoningContentInMessages() = %s, want %s", got, want)
			}
		})
	}
}

func TestDetectIFlowEmbeddedError_BlockedPayload(t *testing.T) {
	body := []byte(`{"status":"434","msg":"Access to the current AK has been blocked due to unauthorized requests","body":null}`)
	err := detectIFlowEmbeddedError(http.Header{}, body)
	if err == nil {
		t.Fatalf("expected embedded error, got nil")
	}
	if err.StatusCode() != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", err.StatusCode(), http.StatusForbidden)
	}
}

func TestDetectIFlowEmbeddedError_CooldownPayload(t *testing.T) {
	body := []byte(`{"error":{"code":"model_cooldown","message":"All credentials are cooling down","reset_seconds":17}}`)
	err := detectIFlowEmbeddedError(http.Header{}, body)
	if err == nil {
		t.Fatalf("expected embedded error, got nil")
	}
	if err.StatusCode() != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want %d", err.StatusCode(), http.StatusTooManyRequests)
	}
	if err.RetryAfter() == nil {
		t.Fatalf("expected retryAfter to be parsed")
	}
	if *err.RetryAfter() < 16*time.Second || *err.RetryAfter() > 18*time.Second {
		t.Fatalf("retryAfter = %v, want ~17s", *err.RetryAfter())
	}
}

func TestDetectIFlowEmbeddedError_SuccessPayload(t *testing.T) {
	body := []byte(`{"id":"chatcmpl-1","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"ok"}}]}`)
	err := detectIFlowEmbeddedError(http.Header{}, body)
	if err != nil {
		t.Fatalf("expected nil for successful payload, got %v", err)
	}
}
