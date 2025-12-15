import React, { useEffect, useRef, useState, useCallback } from "react";
import dictionary from "typo-js";
import type { KeyDef, KeyState, WindowType } from "./types";
import { ALL_KEYS, KEY_LAYOUT } from "./constants";

// σ (sigma): Controls likelihood spread - how forgiving key selection is
// Higher = more forgiving (key center doesn't need to be exact)
const SIGMA_RATIO = 0.5; // Increased for more forgiving selection

// θ (theta): Selection threshold - LOWER = FASTER TYPING
const SELECTION_THRESHOLD = 0.6; // 600ms dwell time (was 1.0)

// k: Dirichlet prior pseudocount. Paper optimal: 1.0
const PRIOR_K = 1.0;

// Gaze smoothing - LIGHT smoothing for responsive cursor
const GAZE_SMOOTHING_ALPHA = 0.4; // Higher = more responsive (was 0.15)

// Keep small history just for noise reduction
const GAZE_HISTORY_SIZE = 3; // Reduced from 8

// Minimum posterior to show visual feedback
const MIN_POSTERIOR_FOR_FEEDBACK = 0.15;

// Special key boost
const SPECIAL_KEY_LIKELIHOOD_BOOST = 0.75;
const SPECIAL_KEY_MIN_PRIOR = 0.75;

// =================================================================
// ZOOM/HYSTERESIS PARAMETERS
// =================================================================

// How much to expand sigma for the active key (1.0 = no expansion)
// Selection logic uses this to be forgiving about which key you meant
const ACTIVE_KEY_SIGMA_EXPANSION = 1.5; // Reduced - less sticky

// Hysteresis threshold - selection logic uses this to avoid accidental switches
const HYSTERESIS_THRESHOLD = 0.12; // Reduced - cursor moves freely

// Minimum time (seconds) to stay on a key before switching
const MIN_DWELL_BEFORE_SWITCH = 0.08; // Reduced for responsiveness

// Visual zoom parameters
const MIN_ZOOM_SCALE = 1.0;
const MAX_ZOOM_SCALE = 1.4; // Larger zoom (was 1.25)

// =================================================================
// VELOCITY-BASED INTENT DETECTION
// =================================================================

// Velocity threshold (pixels per second) - above this, user is scanning/saccading
// LOWER = stricter about what counts as fixation
const VELOCITY_THRESHOLD = 300; // Reduced from 600 - must be really still

// Smoothing for velocity calculation
const VELOCITY_SMOOTHING_ALPHA = 0.3;

// Minimum fixation duration (seconds) before we start accumulating interest
// HIGHER = need to dwell longer before it counts
const MIN_FIXATION_DURATION = 0.12; // Increased from 0.05

export default function GazeKeyboard() {
  // --- UI State ---
  const [running, setRunning] = useState(false);
  const [isCalibrating, setIsCalibrating] = useState(false);
  const [txt, setTxt] = useState("");
  const [suggestion, setSuggestion] = useState<string | null>();
  const [lastTypedKeyId, setLastTypedKeyId] = useState<string | null>(null);

  // --- Gaze State ---
  const [rawGazePoint, setRawGazePoint] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [smoothedGaze, setSmoothedGaze] = useState<{
    x: number;
    y: number;
  } | null>(null);

  const [activeKeyId, setActiveKeyId] = useState<string | null>(null);

  // Track fixation state for cursor rendering
  const [isFixating, setIsFixating] = useState(false);

  // Track zoom levels for smooth animation
  const [keyZoomLevels, setKeyZoomLevels] = useState<Record<string, number>>(
    {}
  );

  // --- Refs ---
  const keyRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const keyStateRef = useRef<Record<string, KeyState>>({});
  const smoothedGazeRef = useRef<{ x: number; y: number } | null>(null);
  const smoothedCursorRef = useRef<{ x: number; y: number } | null>(null);
  const lastTypedTimeoutRef = useRef<number | null>(null);
  const sigmaRef = useRef<number>(40);
  const lastFrameTime = useRef<number>(performance.now());
  const typoRef = useRef<any | null>(null);

  // Track the previous active key for hysteresis
  const previousActiveKeyRef = useRef<string | null>(null);

  // Velocity tracking for intent detection
  const lastGazeRef = useRef<{ x: number; y: number; time: number } | null>(
    null
  );
  const smoothedVelocityRef = useRef<number>(0);
  const fixationStartTimeRef = useRef<number | null>(null);
  const isFixatingRef = useRef<boolean>(false);

  // Gaze history for moving average (extra smoothing)
  const gazeHistoryRef = useRef<Array<{ x: number; y: number }>>([]);

  // Track when we started dwelling on current key
  const currentKeyDwellStartRef = useRef<number | null>(null);

  // =================================================================
  // INITIALIZATION
  // =================================================================

  useEffect(() => {
    if (!typoRef.current) {
      try {
        // @ts-ignore
        typoRef.current = new (dictionary as any)("en_US", null, null, {
          dictionaryPath: "/node_modules/typo-js/dictionaries",
        });
      } catch (e) {
        console.error("Failed to initialize typo-js dictionary", e);
      }
    }
  }, []);

  // Initialize key states with uniform priors
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

  // Calculate sigma from actual key sizes
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

  // Cache key rectangles - NOTE: We cache the BASE rect, not the zoomed rect
  // This is intentional - we want stable hit areas
  const updateKeyRects = useCallback(() => {
    ALL_KEYS.forEach((k) => {
      const el = keyRefs.current[k.id];
      if (el && keyStateRef.current[k.id]) {
        // Get the rect, but account for any current transform
        // We want the "logical" position, not the visual transformed one
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

  // =================================================================
  // SPELL CHECKING
  // =================================================================

  useEffect(() => {
    const typo = typoRef.current;
    if (!typo) return;

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

    const isCorrect = typo.check(word);
    if (isCorrect) {
      setSuggestion(null);
    } else {
      const suggestions = typo.suggest(word, 1);
      setSuggestion(suggestions[0] || null);
    }
  }, [txt, typoRef.current]);

  // =================================================================
  // GAZE CLOUD INTEGRATION
  // =================================================================

  // Reset all gaze state when tracking stops
  const resetGazeState = useCallback(() => {
    setRawGazePoint(null);
    setSmoothedGaze(null);
    setActiveKeyId(null);
    setIsFixating(false);
    smoothedGazeRef.current = null;
    smoothedCursorRef.current = null;
    previousActiveKeyRef.current = null;
    lastGazeRef.current = null;
    smoothedVelocityRef.current = 0;
    fixationStartTimeRef.current = null;
    isFixatingRef.current = false;
    gazeHistoryRef.current = [];
    currentKeyDwellStartRef.current = null;
    setKeyZoomLevels({});

    // Reset all interest to prevent residual selections
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
      // IMPORTANT: Reset all state when tracking is stopped
      resetGazeState();
    }

    return () => {
      if (interval) clearInterval(interval);
      const win = window as unknown as WindowType;
      win?.GazeCloudAPI?.StopEyeTracking();
      // Also reset on cleanup
      resetGazeState();
    };
  }, [running, updateKeyRects, resetGazeState]);

  // =================================================================
  // GAZE SMOOTHING - Multi-stage for maximum stability
  // =================================================================

  useEffect(() => {
    if (!rawGazePoint) {
      setSmoothedGaze(null);
      smoothedGazeRef.current = null;
      gazeHistoryRef.current = [];
      return;
    }

    // Stage 1: Add to history buffer
    gazeHistoryRef.current.push({ ...rawGazePoint });
    if (gazeHistoryRef.current.length > GAZE_HISTORY_SIZE) {
      gazeHistoryRef.current.shift();
    }

    // Stage 2: Calculate moving average from history
    const history = gazeHistoryRef.current;
    const avgX = history.reduce((sum, p) => sum + p.x, 0) / history.length;
    const avgY = history.reduce((sum, p) => sum + p.y, 0) / history.length;

    // Stage 3: Apply exponential smoothing on top of moving average
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

  // =================================================================
  // CORE BAYESGAZE ALGORITHM - WITH ZOOM LOGIC & VELOCITY DETECTION
  // =================================================================

  useEffect(() => {
    let rafId: number;

    const tick = () => {
      // Exit early if not running
      if (!running) {
        return;
      }

      const now = performance.now();
      const actualDt = Math.min((now - lastFrameTime.current) / 1000, 0.1);
      lastFrameTime.current = now;

      if (isCalibrating || !smoothedGaze) {
        setActiveKeyId(null);
        previousActiveKeyRef.current = null;
        lastGazeRef.current = null;
        smoothedVelocityRef.current = 0;
        fixationStartTimeRef.current = null;
        isFixatingRef.current = false;
        rafId = requestAnimationFrame(tick);
        return;
      }

      const state = keyStateRef.current;
      const baseSigma = sigmaRef.current;
      const currentActiveKey = previousActiveKeyRef.current;

      // =================================================================
      // CHECK IF GAZE IS WITHIN KEYBOARD BOUNDS
      // =================================================================
      // Get rough keyboard bounds from first and last keys
      const firstKey = state[ALL_KEYS[0]?.id];
      const lastKey = state[ALL_KEYS[ALL_KEYS.length - 1]?.id];

      let isGazeOnKeyboard = false;
      if (firstKey?.rect && lastKey?.rect) {
        const keyboardBounds = {
          left: Math.min(firstKey.rect.left, lastKey.rect.left) - 50,
          right: Math.max(firstKey.rect.right, lastKey.rect.right) + 50,
          top: Math.min(firstKey.rect.top, lastKey.rect.top) - 50,
          bottom: Math.max(firstKey.rect.bottom, lastKey.rect.bottom) + 50,
        };

        isGazeOnKeyboard =
          smoothedGaze.x >= keyboardBounds.left &&
          smoothedGaze.x <= keyboardBounds.right &&
          smoothedGaze.y >= keyboardBounds.top &&
          smoothedGaze.y <= keyboardBounds.bottom;
      }

      // If gaze is outside keyboard, reset ALL interest (user looking away to reset)
      if (!isGazeOnKeyboard) {
        ALL_KEYS.forEach((key) => {
          if (state[key.id]) {
            state[key.id].interest = 0;
          }
        });
        setActiveKeyId(null);
        setKeyZoomLevels({});
        previousActiveKeyRef.current = null;
        currentKeyDwellStartRef.current = null;
        setIsFixating(false);
        rafId = requestAnimationFrame(tick);
        return;
      }

      // =================================================================
      // VELOCITY CALCULATION - Detect if user is fixating or scanning
      // =================================================================
      let currentVelocity = 0;

      if (lastGazeRef.current) {
        const dx = smoothedGaze.x - lastGazeRef.current.x;
        const dy = smoothedGaze.y - lastGazeRef.current.y;
        const dt = (now - lastGazeRef.current.time) / 1000;

        if (dt > 0) {
          const instantVelocity = Math.hypot(dx, dy) / dt;
          // Smooth the velocity
          smoothedVelocityRef.current =
            VELOCITY_SMOOTHING_ALPHA * instantVelocity +
            (1 - VELOCITY_SMOOTHING_ALPHA) * smoothedVelocityRef.current;
          currentVelocity = smoothedVelocityRef.current;
        }
      }

      lastGazeRef.current = { x: smoothedGaze.x, y: smoothedGaze.y, time: now };

      // Determine if we're in a fixation (low velocity)
      const isLowVelocity = currentVelocity < VELOCITY_THRESHOLD;

      if (isLowVelocity) {
        if (!fixationStartTimeRef.current) {
          fixationStartTimeRef.current = now;
        }
        const fixationDuration = (now - fixationStartTimeRef.current) / 1000;
        isFixatingRef.current = fixationDuration >= MIN_FIXATION_DURATION;
      } else {
        // High velocity - user is scanning/moving through
        fixationStartTimeRef.current = null;
        isFixatingRef.current = false;

        // CRITICAL: When moving fast, RESET interest for ALL keys
        // This prevents accumulation from quick passes
        ALL_KEYS.forEach((key) => {
          if (state[key.id]) {
            // Aggressive decay - almost complete reset when moving fast
            state[key.id].interest *= 0.3; // Was 0.85, now much more aggressive
          }
        });
      }

      // Update state for rendering
      setIsFixating(isFixatingRef.current);

      // =================================================================
      // Step 1: Calculate Likelihoods with EXPANDED SIGMA for active key
      // =================================================================
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

        // KEY ZOOM LOGIC: Active key gets expanded sigma
        const isCurrentlyActive = key.id === currentActiveKey;
        const effectiveSigma = isCurrentlyActive
          ? baseSigma * ACTIVE_KEY_SIGMA_EXPANSION
          : baseSigma;

        let likelihood = Math.exp(
          -(dist * dist) / (2 * effectiveSigma * effectiveSigma)
        );

        // Special key boost
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

      // =================================================================
      // Step 2: Calculate Posteriors
      // =================================================================
      const posteriors: Record<string, number> = {};
      let maxPosterior = 0;
      let bestKeyId: string | null = null;
      let secondBestPosterior = 0;

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
          secondBestPosterior = maxPosterior;
          maxPosterior = posterior;
          bestKeyId = key.id;
        } else if (posterior > secondBestPosterior) {
          secondBestPosterior = posterior;
        }
      });

      // =================================================================
      // Step 3: Apply HYSTERESIS + MINIMUM DWELL TIME - prevent jumping
      // =================================================================
      let finalActiveKeyId = bestKeyId;

      if (currentActiveKey && currentActiveKey !== bestKeyId) {
        const currentKeyPosterior = posteriors[currentActiveKey] || 0;
        const bestPosterior = posteriors[bestKeyId || ""] || 0;

        // Check 1: Hysteresis - key must be significantly better
        const passesHysteresis =
          bestPosterior - currentKeyPosterior >= HYSTERESIS_THRESHOLD;

        // Check 2: Minimum dwell time on current key before allowing switch
        let passesMinDwell = true;
        if (currentKeyDwellStartRef.current) {
          const dwellTime = (now - currentKeyDwellStartRef.current) / 1000;
          passesMinDwell = dwellTime >= MIN_DWELL_BEFORE_SWITCH;
        }

        // Only switch if BOTH conditions are met
        if (!passesHysteresis || !passesMinDwell) {
          finalActiveKeyId = currentActiveKey as any;
        } else {
          // We're switching keys - if we weren't fixating, reset the old key's interest
          // This prevents "sticky" keys from quick passes
          if (!isFixatingRef.current && state[currentActiveKey]) {
            state[currentActiveKey].interest = 0;
          }
        }
      }

      // Update dwell timer when key changes
      if (finalActiveKeyId !== previousActiveKeyRef.current) {
        currentKeyDwellStartRef.current = now;

        // When switching to a key, reset its interest to start fresh
        // (unless we're already fixating, which means intentional movement)
        if (finalActiveKeyId && !isFixatingRef.current) {
          if (state[finalActiveKeyId]) {
            state[finalActiveKeyId].interest = 0;
          }
        }
      }

      // Update the previous active key reference
      previousActiveKeyRef.current = finalActiveKeyId;

      // =================================================================
      // Step 4: Accumulate Interest - ONLY during fixation, ONLY for active key
      // =================================================================
      ALL_KEYS.forEach((key) => {
        const keyState = state[key.id];
        if (!keyState) return;

        const posterior = posteriors[key.id] || 0;

        // ONLY accumulate interest if:
        // 1. We're fixating (low velocity, stable gaze)
        // 2. This is the currently active key
        if (isFixatingRef.current && key.id === finalActiveKeyId) {
          keyState.interest += actualDt * posterior;
        }
      });

      // =================================================================
      // Step 5: Update zoom levels - Zoom IMMEDIATELY when looking at key
      // =================================================================
      const newZoomLevels: Record<string, number> = {};
      ALL_KEYS.forEach((key) => {
        const keyState = state[key.id];
        if (!keyState) return;

        // Zoom the active key immediately (not just during fixation)
        if (key.id === finalActiveKeyId) {
          // Base zoom just for being looked at
          const baseZoom = 1.15;

          // Additional zoom based on interest progress (during fixation)
          if (isFixatingRef.current) {
            const progress = Math.min(
              keyState.interest / SELECTION_THRESHOLD,
              1
            );
            const additionalZoom = (MAX_ZOOM_SCALE - baseZoom) * progress;
            newZoomLevels[key.id] = baseZoom + additionalZoom;
          } else {
            // Still zoom when just looking, but not as much
            newZoomLevels[key.id] = baseZoom;
          }
        } else {
          newZoomLevels[key.id] = MIN_ZOOM_SCALE;
        }
      });
      setKeyZoomLevels(newZoomLevels);

      // =================================================================
      // Step 6: Visual Feedback - Just track which key is active
      // =================================================================
      const displayKeyId = finalActiveKeyId;
      const displayPosterior = posteriors[displayKeyId || ""] || 0;

      // Set active key for highlighting (cursor position is handled separately)
      if (displayKeyId && displayPosterior > MIN_POSTERIOR_FOR_FEEDBACK) {
        setActiveKeyId(displayKeyId);
      } else {
        setActiveKeyId(null);
      }

      // =================================================================
      // Step 7: Check Selection Threshold - Only select the ACTIVE key
      // =================================================================
      const activeKeyState = finalActiveKeyId ? state[finalActiveKeyId] : null;
      const activeKeyInterest = activeKeyState?.interest || 0;

      if (
        isFixatingRef.current &&
        finalActiveKeyId &&
        activeKeyInterest >= SELECTION_THRESHOLD
      ) {
        const keyDef = ALL_KEYS.find((k) => k.id === finalActiveKeyId);
        if (keyDef) {
          triggerSelection(keyDef);
        }
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [running, smoothedGaze, isCalibrating]);

  // =================================================================
  // SELECTION & PRIOR UPDATE
  // =================================================================

  const triggerSelection = (keyDef: KeyDef) => {
    handleTypeKey(keyDef);

    const state = keyStateRef.current;
    const N = ALL_KEYS.length;

    if (state[keyDef.id]) {
      state[keyDef.id].interest = 0;
      state[keyDef.id].selectionCount++;
    }

    // Reset hysteresis, velocity tracking, and dwell timer after selection
    previousActiveKeyRef.current = null;
    fixationStartTimeRef.current = null;
    isFixatingRef.current = false;
    smoothedCursorRef.current = null;
    currentKeyDwellStartRef.current = null;

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

    console.log(
      `Selected: ${keyDef.label} | Prior: ${state[keyDef.id]?.prior.toFixed(4)}`
    );
  };

  // =================================================================
  // KEY TYPING HANDLER
  // =================================================================

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

  // =================================================================
  // RESET FUNCTION
  // =================================================================

  const handleClear = useCallback(() => {
    setTxt("");
    previousActiveKeyRef.current = null;
    // Reset velocity tracking
    lastGazeRef.current = null;
    smoothedVelocityRef.current = 0;
    fixationStartTimeRef.current = null;
    isFixatingRef.current = false;
    gazeHistoryRef.current = [];
    currentKeyDwellStartRef.current = null;

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
    setKeyZoomLevels({});
  }, []);

  // =================================================================
  // RENDER
  // =================================================================

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
                ? "👁️ Tracking"
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
          placeholder="Gaze-typed text will appear here..."
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

                // Get progressive zoom level
                const zoomLevel = keyZoomLevels[k.id] || MIN_ZOOM_SCALE;

                // Calculate progress for visual feedback (ring around key)
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
                      // PROGRESSIVE ZOOM based on accumulated interest
                      transform: `scale(${zoomLevel})`,
                      zIndex: isActive ? 10 : 1,
                      // Border shows progress toward selection
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

                    {/* Progress indicator ring */}
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

      {/* Cursor Visualizations - Shows ACTUAL gaze position */}
      {!isCalibrating && running && smoothedGaze && (
        <>
          {/* Main gaze cursor - follows actual gaze position */}
          <div
            style={{
              position: "fixed",
              left: smoothedGaze.x,
              top: smoothedGaze.y,
              width: 20,
              height: 20,
              borderRadius: "50%",
              background: isFixating
                ? "rgba(0, 123, 255, 0.4)"
                : "rgba(100, 100, 100, 0.25)",
              border: isFixating
                ? "2px solid rgba(0, 123, 255, 0.9)"
                : "2px solid rgba(100, 100, 100, 0.5)",
              transform: "translate(-50%, -50%)",
              pointerEvents: "none",
              zIndex: 9999,
              // Fast transition for responsive feel
              transition:
                "background 0.1s, border 0.1s, width 0.1s, height 0.1s",
            }}
          />
        </>
      )}
    </div>
  );
}

// =================================================================
// STYLES
// =================================================================

const styles: Record<string, React.CSSProperties> = {
  calibrationOverlay: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: "rgba(0, 0, 0, 0.85)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10000,
  },
  calibrationMessage: {
    color: "white",
    textAlign: "center",
    padding: 40,
    background: "rgba(50, 50, 50, 0.95)",
    borderRadius: 16,
  },
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
    // Faster zoom transition for immediate feedback
    transition:
      "transform 0.08s ease-out, border 0.08s, box-shadow 0.1s, background-color 0.15s",
    cursor: "default",
    userSelect: "none",
    // Ensure transform origin is center for proper zoom
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
