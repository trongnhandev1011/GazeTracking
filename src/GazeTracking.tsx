import React, { useEffect, useRef, useState, useCallback } from "react";

interface KeyDef {
  id: string;
  label: string;
  value?: string;
  role?: string;
  special?: boolean;
  wide?: boolean;
  fullWidth?: boolean;
}

interface KeyState {
  interest: number;
  selectionCount: number;
  prior: number;
  rect: DOMRect | null;
  lastPosterior: number;
}

interface WindowType extends Window {
  GazeCloudAPI?: any;
  OnResult?: (data: any) => void;
  OnCalibrationComplete?: () => void;
  UseClickRecalibration?: boolean;
}

// BASELINE PARAMETERS - Traditional BayesGaze WITHOUT your innovations
const SIGMA_RATIO = 0.5;
const SELECTION_THRESHOLD = 1.0; // Traditional 1 second dwell (vs 0.6s)
const PRIOR_K = 1.0;
const GAZE_SMOOTHING_ALPHA = 0.15; // More smoothing (vs 0.4)
const GAZE_HISTORY_SIZE = 8; // More history (vs 3)
const MIN_POSTERIOR_FOR_FEEDBACK = 0.15;
const SPECIAL_KEY_LIKELIHOOD_BOOST = 0.75;
const SPECIAL_KEY_MIN_PRIOR = 0.75;

// NO velocity detection
// NO progressive zoom
// NO single-key accumulation

const ALL_KEYS: KeyDef[] = [
  // Row 1
  { id: "q", label: "Q", value: "q" },
  { id: "w", label: "W", value: "w" },
  { id: "e", label: "E", value: "e" },
  { id: "r", label: "R", value: "r" },
  { id: "t", label: "T", value: "t" },
  { id: "y", label: "Y", value: "y" },
  { id: "u", label: "U", value: "u" },
  { id: "i", label: "I", value: "i" },
  { id: "o", label: "O", value: "o" },
  { id: "p", label: "P", value: "p" },
  // Row 2
  { id: "a", label: "A", value: "a" },
  { id: "s", label: "S", value: "s" },
  { id: "d", label: "D", value: "d" },
  { id: "f", label: "F", value: "f" },
  { id: "g", label: "G", value: "g" },
  { id: "h", label: "H", value: "h" },
  { id: "j", label: "J", value: "j" },
  { id: "k", label: "K", value: "k" },
  { id: "l", label: "L", value: "l" },
  // Row 3
  { id: "z", label: "Z", value: "z" },
  { id: "x", label: "X", value: "x" },
  { id: "c", label: "C", value: "c" },
  { id: "v", label: "V", value: "v" },
  { id: "b", label: "B", value: "b" },
  { id: "n", label: "N", value: "n" },
  { id: "m", label: "M", value: "m" },
  { id: "back", label: "⌫", special: true, wide: true },
  // Row 4
  { id: "space-left", label: "Space", role: "space-left", fullWidth: true },
  { id: "space-suggest", label: "", role: "space-suggest", fullWidth: true },
];

const KEY_LAYOUT = [
  ALL_KEYS.slice(0, 10),
  ALL_KEYS.slice(10, 19),
  ALL_KEYS.slice(19, 27),
  ALL_KEYS.slice(27),
];

// Mock dictionary
const mockDictionary = {
  check: (word: string) => {
    const common = ["hello", "world", "the", "quick", "brown", "fox"];
    return common.includes(word.toLowerCase());
  },
  suggest: (word: string) => {
    const suggestions: Record<string, string[]> = {
      helo: ["hello"],
      hellp: ["hello"],
      heklo: ["hello"],
      hrllo: ["hello"],
      wrold: ["world"],
      wprld: ["world"],
      wirld: ["world"],
      wotld: ["world"],
    };
    return suggestions[word.toLowerCase()] || [];
  },
};

export default function GazeKeyboardBaseline() {
  const [running, setRunning] = useState(false);
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [txt, setTxt] = useState("");
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [lastTypedKeyId, setLastTypedKeyId] = useState<string | null>(null);
  const [rawGazePoint, setRawGazePoint] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [smoothedGaze, setSmoothedGaze] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [activeKeyId, setActiveKeyId] = useState<string | null>(null);

  const keyRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const keyStateRef = useRef<Record<string, KeyState>>({});
  const smoothedGazeRef = useRef<{ x: number; y: number } | null>(null);
  const lastTypedTimeoutRef = useRef<number | null>(null);
  const sigmaRef = useRef<number>(40);
  const lastFrameTime = useRef<number>(performance.now());
  const gazeHistoryRef = useRef<Array<{ x: number; y: number }>>([]);

  // Initialize key states
  useEffect(() => {
    const N = ALL_KEYS.length;
    const uniformPrior = 1.0 / N;
    ALL_KEYS.forEach((k) => {
      if (!keyStateRef.current[k.id]) {
        keyStateRef.current[k.id] = {
          interest: 0,
          selectionCount: 0,
          prior: uniformPrior,
          rect: null,
          lastPosterior: 0,
        };
      }
    });
  }, []);

  // Calculate sigma
  useEffect(() => {
    const updateSigma = () => {
      const firstKeyRef = keyRefs.current[ALL_KEYS[0]?.id];
      if (firstKeyRef) {
        const rect = firstKeyRef.getBoundingClientRect();
        const keySize = Math.min(rect.width, rect.height);
        sigmaRef.current = keySize * SIGMA_RATIO;
      }
    };
    const timeout = setTimeout(updateSigma, 500);
    window.addEventListener("resize", updateSigma);
    return () => {
      clearTimeout(timeout);
      window.removeEventListener("resize", updateSigma);
    };
  }, [running]);

  // Cache key rectangles
  const updateKeyRects = useCallback(() => {
    ALL_KEYS.forEach((k) => {
      const el = keyRefs.current[k.id];
      if (el && keyStateRef.current[k.id]) {
        keyStateRef.current[k.id].rect = el.getBoundingClientRect();
      }
    });
  }, []);

  useEffect(() => {
    if (!running || isCalibrating) return;
    updateKeyRects();
    const interval = setInterval(updateKeyRects, 1000);
    window.addEventListener("resize", updateKeyRects);
    return () => {
      clearInterval(interval);
      window.removeEventListener("resize", updateKeyRects);
    };
  }, [running, isCalibrating, updateKeyRects]);

  // Spell checking
  useEffect(() => {
    const match = txt.match(/(\S+)$/);
    if (!match) {
      setSuggestion(null);
      return;
    }
    const word = match[1];
    if (!word) {
      setSuggestion(null);
      return;
    }
    const isCorrect = mockDictionary.check(word);
    if (isCorrect) {
      setSuggestion(null);
    } else {
      const suggestions = mockDictionary.suggest(word);
      setSuggestion(suggestions[0] || null);
    }
  }, [txt]);

  // GazeCloudAPI Integration - SAME AS YOUR CODE
  const resetGazeState = useCallback(() => {
    setRawGazePoint(null);
    setSmoothedGaze(null);
    setActiveKeyId(null);
    smoothedGazeRef.current = null;
    gazeHistoryRef.current = [];

    ALL_KEYS.forEach((k) => {
      if (keyStateRef.current[k.id]) {
        keyStateRef.current[k.id].interest = 0;
      }
    });
  }, []);

  useEffect(() => {
    let interval: number | undefined;

    if (running) {
      setIsCalibrating(true);

      interval = window.setInterval(() => {
        const win = window as unknown as WindowType;
        if (win.GazeCloudAPI) {
          clearInterval(interval);
          win.UseClickRecalibration = true;

          win.OnResult = (d) => {
            if (d.state === 0) {
              const clientX = d.docX - window.scrollX;
              const clientY = d.docY - window.scrollY;
              setRawGazePoint({ x: clientX, y: clientY });
            } else {
              setRawGazePoint(null);
            }
          };

          win.OnCalibrationComplete = () => {
            setIsCalibrating(false);
            updateKeyRects();
          };

          win.GazeCloudAPI.StartEyeTracking();
        }
      }, 300);
    } else {
      resetGazeState();
    }

    return () => {
      if (interval) clearInterval(interval);
      const win = window as unknown as WindowType;
      win?.GazeCloudAPI?.StopEyeTracking();
      resetGazeState();
    };
  }, [running, updateKeyRects, resetGazeState]);

  // Gaze smoothing - BASELINE: More smoothing, less responsive
  useEffect(() => {
    if (!rawGazePoint) {
      setSmoothedGaze(null);
      smoothedGazeRef.current = null;
      gazeHistoryRef.current = [];
      return;
    }

    gazeHistoryRef.current.push({ ...rawGazePoint });
    if (gazeHistoryRef.current.length > GAZE_HISTORY_SIZE) {
      gazeHistoryRef.current.shift();
    }

    const history = gazeHistoryRef.current;
    const avgX = history.reduce((sum, p) => sum + p.x, 0) / history.length;
    const avgY = history.reduce((sum, p) => sum + p.y, 0) / history.length;

    if (!smoothedGazeRef.current) {
      smoothedGazeRef.current = { x: avgX, y: avgY };
    } else {
      smoothedGazeRef.current = {
        x:
          GAZE_SMOOTHING_ALPHA * avgX +
          (1 - GAZE_SMOOTHING_ALPHA) * smoothedGazeRef.current.x,
        y:
          GAZE_SMOOTHING_ALPHA * avgY +
          (1 - GAZE_SMOOTHING_ALPHA) * smoothedGazeRef.current.y,
      };
    }

    setSmoothedGaze({ ...smoothedGazeRef.current });
  }, [rawGazePoint]);

  // BASELINE BAYESGAZE - Traditional approach WITHOUT your innovations
  useEffect(() => {
    let rafId: number;

    const tick = () => {
      if (!running) return;

      const now = performance.now();
      const actualDt = Math.min((now - lastFrameTime.current) / 1000, 0.1);
      lastFrameTime.current = now;

      if (isCalibrating || !smoothedGaze) {
        setActiveKeyId(null);
        rafId = requestAnimationFrame(tick);
        return;
      }

      const state = keyStateRef.current;
      const baseSigma = sigmaRef.current;

      // Step 1: Calculate Likelihoods - BASELINE: No expanded sigma
      const likelihoods: Record<string, number> = {};
      let totalWeightedLikelihood = 0;

      ALL_KEYS.forEach((key) => {
        const keyState = state[key.id];
        if (!keyState?.rect) return;

        const rect = keyState.rect;
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const dist = Math.hypot(
          smoothedGaze.x - centerX,
          smoothedGaze.y - centerY
        );

        // BASELINE: Fixed sigma for all keys (no hysteresis/expansion)
        let likelihood = Math.exp(-(dist * dist) / (2 * baseSigma * baseSigma));

        const isSpecialKey =
          key.special ||
          key.role === "space-left" ||
          key.role === "space-suggest";
        if (isSpecialKey) {
          likelihood *= SPECIAL_KEY_LIKELIHOOD_BOOST;
        }

        likelihoods[key.id] = likelihood;

        const effectivePrior = isSpecialKey
          ? Math.max(keyState.prior, SPECIAL_KEY_MIN_PRIOR)
          : keyState.prior;

        totalWeightedLikelihood += likelihood * effectivePrior;
      });

      if (totalWeightedLikelihood < 1e-10) {
        totalWeightedLikelihood = 1e-10;
      }

      // Step 2: Calculate Posteriors
      const posteriors: Record<string, number> = {};
      let maxPosterior = 0;
      let bestKeyId: string | null = null;

      ALL_KEYS.forEach((key) => {
        const keyState = state[key.id];
        if (!keyState) return;

        const likelihood = likelihoods[key.id] || 0;
        const isSpecialKey =
          key.special ||
          key.role === "space-left" ||
          key.role === "space-suggest";
        const effectivePrior = isSpecialKey
          ? Math.max(keyState.prior, SPECIAL_KEY_MIN_PRIOR)
          : keyState.prior;

        const posterior =
          (likelihood * effectivePrior) / totalWeightedLikelihood;
        posteriors[key.id] = posterior;
        keyState.lastPosterior = posterior;

        if (posterior > maxPosterior) {
          maxPosterior = posterior;
          bestKeyId = key.id;
        }
      });

      // Step 3: BASELINE - Multi-key accumulation (original BayesGaze)
      // NO velocity detection - always accumulating
      // ALL keys accumulate proportional to posterior
      ALL_KEYS.forEach((key) => {
        const keyState = state[key.id];
        if (!keyState) return;

        const posterior = posteriors[key.id] || 0;
        // CRITICAL: All keys accumulate interest, not just active key
        keyState.interest += actualDt * posterior;
      });

      // Step 4: Visual feedback
      if (bestKeyId && posteriors[bestKeyId] > MIN_POSTERIOR_FOR_FEEDBACK) {
        setActiveKeyId(bestKeyId);
      } else {
        setActiveKeyId(null);
      }

      // Step 5: Check for selection - ANY key that reaches threshold
      ALL_KEYS.forEach((key) => {
        const keyState = state[key.id];
        if (keyState && keyState.interest >= SELECTION_THRESHOLD) {
          const keyDef = ALL_KEYS.find((k) => k.id === key.id);
          if (keyDef) {
            triggerSelection(keyDef);
          }
        }
      });

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [running, smoothedGaze, isCalibrating]);

  const triggerSelection = (keyDef: KeyDef) => {
    handleTypeKey(keyDef);

    const state = keyStateRef.current;
    const N = ALL_KEYS.length;

    if (state[keyDef.id]) {
      state[keyDef.id].interest = 0;
      state[keyDef.id].selectionCount++;
    }

    ALL_KEYS.forEach((k) => {
      if (k.id !== keyDef.id && state[k.id]) {
        state[k.id].interest *= 0.5;
      }
    });

    let sumCounts = 0;
    ALL_KEYS.forEach((k) => {
      if (state[k.id]) {
        sumCounts += state[k.id].selectionCount;
      }
    });

    const denominator = PRIOR_K * N + sumCounts;
    ALL_KEYS.forEach((k) => {
      if (state[k.id]) {
        state[k.id].prior =
          (PRIOR_K + state[k.id].selectionCount) / denominator;
      }
    });
  };

  const handleTypeKey = (k: KeyDef) => {
    if (k.role === "space-left") {
      setTxt((s) => s + " ");
    } else if (k.role === "space-suggest") {
      if (suggestion) {
        setTxt((prev) => {
          const parts = prev.split(/(\s+)/);
          let i = parts.length - 1;
          while (i >= 0 && /^\s+$/.test(parts[i])) i--;
          if (i >= 0) parts[i] = suggestion;
          else parts.push(suggestion);
          return parts.join("") + " ";
        });
      } else {
        setTxt((s) => s + " ");
      }
    } else if (k.special) {
      if (k.id.includes("back")) {
        setTxt((s) => s.slice(0, -1));
      } else if (k.id.includes("enter")) {
        setTxt((s) => s + "\n");
      } else if (k.id.includes("space")) {
        setTxt((s) => s + (k.value ?? " "));
      }
    } else {
      setTxt((s) => s + (k.value ?? k.label));
    }

    setLastTypedKeyId(k.id);
    if (lastTypedTimeoutRef.current) {
      clearTimeout(lastTypedTimeoutRef.current);
    }
    lastTypedTimeoutRef.current = window.setTimeout(() => {
      setLastTypedKeyId(null);
    }, 250);
  };

  const handleClear = useCallback(() => {
    setTxt("");
    const N = ALL_KEYS.length;
    const uniformPrior = 1.0 / N;
    ALL_KEYS.forEach((k) => {
      if (keyStateRef.current[k.id]) {
        keyStateRef.current[k.id].interest = 0;
        keyStateRef.current[k.id].selectionCount = 0;
        keyStateRef.current[k.id].prior = uniformPrior;
        keyStateRef.current[k.id].lastPosterior = 0;
      }
    });
  }, []);

  return (
    <div>
      {/* Controls */}
      {!isCalibrating && (
        <div style={styles.controls}>
          <button onClick={() => setRunning((r) => !r)} style={styles.btn}>
            {running ? "Stop Tracking" : "Start Tracking"}
          </button>
          <button onClick={handleClear} style={styles.btn}>
            Clear
          </button>
          <span style={styles.status}>
            {running
              ? smoothedGaze
                ? "👁️ Tracking (BASELINE)"
                : "⏳ Waiting..."
              : "⏸️ Stopped"}
          </span>
        </div>
      )}

      {/* Text Area */}
      {!isCalibrating && (
        <textarea
          value={txt}
          readOnly
          placeholder="BASELINE: Traditional BayesGaze (multi-key, no velocity, 1.0s threshold)"
          style={styles.textarea}
        />
      )}

      {/* Keyboard */}
      {!isCalibrating && (
        <div style={styles.keyboardContainer}>
          {KEY_LAYOUT.map((row, rIdx) => (
            <div key={rIdx} style={styles.row}>
              {row.map((k) => {
                const isSpaceSuggest = k.role === "space-suggest";
                const displayLabel = isSpaceSuggest
                  ? suggestion ?? ""
                  : k.label;
                const isActive = activeKeyId === k.id;
                const isTyped = lastTypedKeyId === k.id;
                const isSpecialKey =
                  k.special ||
                  k.role === "space-left" ||
                  k.role === "space-suggest";

                // BASELINE: NO zoom (always 1.0)
                const zoomLevel = 1.0;

                const keyState = keyStateRef.current[k.id];
                const progress = keyState
                  ? Math.min(keyState.interest / SELECTION_THRESHOLD, 1)
                  : 0;

                return (
                  <div
                    key={k.id}
                    ref={(el: any) => (keyRefs.current[k.id] = el)}
                    style={{
                      ...styles.key,
                      ...(k.wide ? styles.keyWide : {}),
                      ...(k.fullWidth ? styles.keyFullWidth : {}),
                      transform: `scale(${zoomLevel})`,
                      zIndex: isActive ? 10 : 1,
                      border: isActive
                        ? `3px solid rgba(0, 123, 255, ${0.5 + progress * 0.5})`
                        : "1px solid #ccc",
                      backgroundColor: isTyped
                        ? "#90EE90"
                        : isSpecialKey
                        ? "#e8f4fc"
                        : "#f8f8f8",
                      boxShadow: isActive
                        ? `0 8px ${15 + progress * 15}px rgba(0, 123, 255, ${
                            0.2 + progress * 0.25
                          })`
                        : "0 2px 4px rgba(0,0,0,0.08)",
                    }}
                  >
                    <span style={styles.keyLabel}>{displayLabel}</span>

                    {isActive && progress > 0.1 && (
                      <div
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          right: 0,
                          bottom: 0,
                          borderRadius: 12,
                          border: `${2 + progress * 3}px solid transparent`,
                          borderTopColor: `rgba(0, 123, 255, ${progress})`,
                          borderRightColor:
                            progress > 0.25
                              ? `rgba(0, 123, 255, ${progress})`
                              : "transparent",
                          borderBottomColor:
                            progress > 0.5
                              ? `rgba(0, 123, 255, ${progress})`
                              : "transparent",
                          borderLeftColor:
                            progress > 0.75
                              ? `rgba(0, 123, 255, ${progress})`
                              : "transparent",
                          pointerEvents: "none",
                          animation: "none",
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {/* Cursor - Red for baseline */}
      {!isCalibrating && running && smoothedGaze && (
        <div
          style={{
            position: "fixed",
            left: smoothedGaze.x,
            top: smoothedGaze.y,
            width: 20,
            height: 20,
            borderRadius: "50%",
            background: "rgba(255, 0, 0, 0.4)",
            border: "2px solid rgba(255, 0, 0, 0.9)",
            transform: "translate(-50%, -50%)",
            pointerEvents: "none",
            zIndex: 9999,
            transition: "background 0.1s, border 0.1s",
          }}
        />
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  controls: {
    position: "fixed",
    top: 10,
    left: 10,
    zIndex: 9998,
    display: "flex",
    gap: 10,
    alignItems: "center",
    background: "rgba(255, 255, 255, 0.97)",
    padding: 12,
    borderRadius: 12,
    boxShadow: "0 4px 20px rgba(0, 0, 0, 0.15)",
  },
  btn: {
    padding: "12px 20px",
    borderRadius: 8,
    border: "1px solid #bbb",
    background: "white",
    cursor: "pointer",
    fontSize: 15,
    fontWeight: 500,
  },
  status: {
    marginLeft: 10,
    fontSize: 15,
    color: "#555",
  },
  textarea: {
    position: "fixed",
    top: 75,
    left: 12,
    right: 12,
    height: 70,
    zIndex: 9998,
    fontSize: 20,
    padding: 14,
    borderRadius: 12,
    border: "1px solid #ddd",
    background: "rgba(255, 255, 255, 0.98)",
    resize: "none",
    fontFamily: "system-ui, sans-serif",
  },
  keyboardContainer: {
    position: "fixed",
    top: 180,
    left: "50%",
    transform: "translateX(-50%)",
    width: "90vw",
    height: "65vh",
    zIndex: 9997,
    background: "white",
    padding: 14,
    borderRadius: 20,
    boxShadow: "0 10px 50px rgba(0, 0, 0, 0.25)",
    display: "flex",
    flexDirection: "column",
    gap: 20,
  },
  row: {
    display: "flex",
    gap: 20,
    justifyContent: "center",
    flex: 1,
  },
  key: {
    position: "relative",
    flex: 1,
    borderRadius: 12,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#f8f8f8",
    fontSize: 28,
    fontWeight: 600,
    fontFamily: "system-ui, sans-serif",
    border: "1px solid #ccc",
    transition:
      "transform 0.08s ease-out, border 0.08s, box-shadow 0.1s, background-color 0.15s",
    cursor: "default",
    userSelect: "none",
    transformOrigin: "center center",
  },
  keyWide: {
    flex: 1.8,
  },
  keyFullWidth: {
    flex: "1 1 100%",
  },
  keyLabel: {
    zIndex: 2,
    position: "relative",
  },
};
