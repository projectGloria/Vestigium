import type { Step, StepRunResult } from '../../shared/types.js';

function hostOf(url: string) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

// Read-only view of how a step finds its element: where (tab, frames, shadow hosts) and with what (ranked locators).
export function LocatorInspector({ step, result }: { step: Step; result: StepRunResult | undefined }) {
  const matched = result?.locator ?? null;
  return (
    <div className="locators">
      <dl className="target">
        <dt>Tab</dt><dd>{step.target.tab}</dd>
        {step.target.frames.length > 0 && <><dt>Frames</dt><dd>{step.target.frames.map(frame => hostOf(frame.url)).join(' › ')}</dd></>}
        {step.target.shadowHosts.length > 0 && <><dt>Shadow</dt><dd><code>{step.target.shadowHosts.join(' › ')}</code></dd></>}
        {step.type === 'navigate' && <><dt>URL</dt><dd><code>{step.params.url}</code></dd></>}
      </dl>
      {step.locators.length > 0 && (
        <table aria-label="Locators">
          <thead><tr><th>Strategy</th><th>Value</th><th>Confidence</th></tr></thead>
          <tbody>
            {step.locators.map(locator => {
              const used = matched === `${locator.strategy}: ${locator.value}`;
              return (
                <tr key={`${locator.strategy}:${locator.value}`} className={used ? 'used' : undefined}>
                  <td>{locator.strategy}{used && <span className="badge">used</span>}</td>
                  <td><code title={locator.value}>{locator.value}</code></td>
                  <td>{Math.round(locator.confidence * 100)}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
