import { describe, expect, it } from 'vitest';
import { neutralizeWorkflowCommands, oneLine } from '../src/report/shared.js';
import { allRules } from '../src/rules.js';

describe('R4: neutralizer and oneLine', () => {
  it('neutralizes markers after any Unicode whitespace and after CR', () => {
    for (const ws of ['\u00a0', '\u3000', '\ufeff', '\u2003', '\u0085', '\f', '\v', ' \t']) {
      const out = neutralizeWorkflowCommands(`ok\n${ws}::error::x`);
      expect(out, JSON.stringify(ws)).toContain('\u200b::error');
    }
    const cr = neutralizeWorkflowCommands('progress\r::set-env name=A::1\r##[group]x');
    expect(cr).toBe('progress\r\u200b::set-env name=A::1\r\u200b##[group]x');
    expect(neutralizeWorkflowCommands('a ::b')).toBe('a ::b');
  });

  it('oneLine strips C1 controls and bidi overrides', () => {
    expect(oneLine('a\u009b31mb\u0085c\u202eevil\u2066x\u2069')).toBe('a31mb cevilx');
  });
});

describe('R8: bib-outside-project is a registered rule', () => {
  it('is documented', () => {
    expect(allRules().find((r) => r.id === 'bib-outside-project')).toMatchObject({
      check: 'references',
    });
  });
});
