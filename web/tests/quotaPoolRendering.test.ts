import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { QuotaPoolsSection } from '@/features/quota/pool/QuotaPoolsSection';
import { DEFAULT_POOL_PREFS } from '@/features/quota/pool/poolPrefs';
import { orderPoolProviders } from '@/features/quota/pool/poolModel';
import { normalizeQuotaPoolsResponse } from '@/services/api/quotaPools';
import { buildQuotaPoolsFixture } from './fixtures/quotaPools';

const NOW = new Date(2026, 10, 18, 12).getTime();
const data = normalizeQuotaPoolsResponse(buildQuotaPoolsFixture(NOW));

// Pin English for readable assertions and restore it so later suites keep their locale.
const originalLanguage = i18n.language;
beforeAll(async () => {
  await i18n.changeLanguage('en');
});
afterAll(async () => {
  await i18n.changeLanguage(originalLanguage);
});

const render = (overrides: Partial<typeof DEFAULT_POOL_PREFS> = {}) =>
  renderToStaticMarkup(
    createElement(QuotaPoolsSection, {
      data,
      providers: orderPoolProviders(data.credentials),
      prefs: { ...DEFAULT_POOL_PREFS, ...overrides },
      onPrefsChange: () => {},
      now: NOW,
      offsetWeeks: 0,
      onOffsetWeeksChange: () => {},
      locale: 'en',
      resolvedTheme: 'dark',
      chartWidth: 1200,
    })
  );

describe('QuotaPoolsSection rendering', () => {
  test('orders providers Claude first and skips disabled-only providers', () => {
    expect(orderPoolProviders(data.credentials)).toEqual(['claude', 'codex']);
  });

  test('renders one card per pool with headline, stats and chart', () => {
    const markup = render();
    // Claude: 70 + 95 + 40 of 300; Codex: 200 (pro, 2.5x) + 30 of 350.
    expect(markup).toContain('205%');
    expect(markup).toContain('of 300%');
    expect(markup).toContain('230%');
    expect(markup).toContain('of 350%');
    expect(markup).toContain('Pro Max = 2.5x');
    expect(markup).toContain('Pool empty');
    expect(markup).toContain('First empty');
    expect(markup).toContain('Next reset');
    expect(markup).toContain('Burn, last 3h');
    expect(markup).toContain('Nov 15 to Nov 29');
    expect(markup).toContain('>Now<');
    expect(markup.match(/<svg[^>]*role="img"/g)).toHaveLength(2);
    expect(markup).toContain('stroke-dasharray="6 5"');
    expect(markup).not.toContain('<table');
    // Remaining mode labels reset jumps above the step.
    expect(markup).toMatch(/<text[^>]*>\+\d+%<\/text>/);
  });

  test('shows the accounts table with plan capacity inputs when toggled', () => {
    const markup = render({ showAccounts: true, mode: 'remaining' });
    expect(markup.match(/<table/g)).toHaveLength(2);
    expect(markup).toContain('a@example.test');
    expect(markup).toContain('aria-label="Capacity multiplier for Pro Max"');
  });

  test('renders drain-rate mode without reset labels', () => {
    const markup = render({ mode: 'drain' });
    expect(markup).toContain('%/h');
    expect(markup).not.toMatch(/<text[^>]*>\+\d+%<\/text>/);
  });
});
