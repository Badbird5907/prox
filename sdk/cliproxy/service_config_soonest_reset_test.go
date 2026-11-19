package cliproxy

import (
	"testing"

	internalconfig "github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	coreauth "github.com/router-for-me/CLIProxyAPI/v8/sdk/cliproxy/auth"
)

func TestSoonestResetStrategyAliases(t *testing.T) {
	for _, name := range []string{"soonest-reset", "reset-first", "quota-first", " Soonest-Reset-First "} {
		cfg := &internalconfig.Config{}
		cfg.Routing.Strategy = name
		state := normalizedRoutingRuntimeState(cfg)
		if state.strategy != "soonest-reset" {
			t.Fatalf("strategy %q normalized to %q", name, state.strategy)
		}
		if _, ok := newRoutingSelector(state).(*coreauth.SoonestResetSelector); !ok {
			t.Fatalf("strategy %q did not build a SoonestResetSelector", name)
		}
	}
}
