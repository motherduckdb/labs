'use client';

import {
  CANONICAL_DEMO_DATABASE,
  DEMO_STEPS,
  getDemoStep,
  type DemoModeState,
  type DemoStepId,
} from '@/lib/demo-mode';

export function DemoRail({
  demoMode,
  onStepChange,
  onInsertPrompt,
  onReplayStep,
  onToggleReplay,
  onReset,
}: {
  demoMode: DemoModeState;
  onStepChange: (id: DemoStepId) => void;
  onInsertPrompt: (prompt: string) => void;
  onReplayStep: (id: DemoStepId) => void;
  onToggleReplay: (next: boolean) => void;
  onReset: () => void;
}) {
  const activeStep = getDemoStep(demoMode.activeStepId);

  return (
    <aside className="demo-rail">
      <div className="rail-section rail-hero">
        <div className="eyebrow">Demo Mode</div>
        <h2>NBA box scores workshop</h2>
        <p>
          Presenter path for <code>{CANONICAL_DEMO_DATABASE}</code>: schema, durable context,
          grain checks, charting, and refusal.
        </p>
        <label className="mode-toggle">
          <input
            type="checkbox"
            checked={demoMode.replay}
            onChange={(event) => onToggleReplay(event.target.checked)}
          />
          <span>Replay validation transcript</span>
        </label>
      </div>

      <div className="rail-section step-list" aria-label="Demo scenario steps">
        {DEMO_STEPS.map((step) => (
          <button
            key={step.id}
            onClick={() => onStepChange(step.id)}
            className={`step-button ${step.id === demoMode.activeStepId ? 'active' : ''}`}
          >
            <span className="step-index">{step.order}</span>
            <span className="step-copy">
              <span className="step-eyebrow">{step.eyebrow}</span>
              <span className="step-title">{step.title}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="rail-section active-step-card">
        <div className="eyebrow">{activeStep.eyebrow}</div>
        <h3>{activeStep.title}</h3>
        <p>{activeStep.presenterGoal}</p>

        {activeStep.samplePrompt && (
          <div className="prompt-card">
            <div className="prompt-label">Sample prompt</div>
            <p>{activeStep.samplePrompt}</p>
            <div className="prompt-actions">
              <button onClick={() => onInsertPrompt(activeStep.samplePrompt!)}>Insert</button>
              {demoMode.replay && (
                <button onClick={() => onReplayStep(activeStep.id)}>Replay</button>
              )}
            </div>
          </div>
        )}

        <details className="why-card">
          <summary>Why this matters</summary>
          <p>{activeStep.whyItMatters}</p>
        </details>

        <div className="learning-card">
          <div className="prompt-label">Expected learning moment</div>
          <p>{activeStep.expectedLearning}</p>
          <div className="activity-pills">
            {activeStep.expectedActivity.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
        </div>

        {activeStep.id === 'reset-workshop' && (
          <button className="reset-button" onClick={onReset}>
            Reset local workshop state
          </button>
        )}
      </div>
    </aside>
  );
}
