# GazeBoard: Baseline Bayesian Gaze Typing Interface

This project implements a web-based, eye-gaze controlled keyboard using React and the GazeCloudAPI. It utilizes a **Bayesian Inference** framework to interpret noisy eye-tracking data and determine user intent.

**Note:** This specific implementation represents the **Baseline Control** logic. It replicates traditional dwell-based and probability-based methods (standard BayesGaze) _without_ velocity detection, dynamic zooming, or single-key accumulation, serving as a standard for performance comparison.

Deployment link: https://my-vite-etln2ivha-trongnhandev1011s-projects.vercel.app/

## 📂 Project Structure

The codebase is organized to separate data definitions, logic hooks, and UI components.

- **`constants/`**
  - Contains constant definitions related to the key layout (QWERTY grids), key dimensions, and configuration flags.
- **`hooks/`**
  - Contains custom React hooks, specifically helper functions for integration and auto-correction suggestions.
- **`types/`**
  - Contains TypeScript definitions for the application, including `KeyDef` (static key properties) and `KeyState` (dynamic probability values).
- **`components/`**
  - Contains the main logic and UI components, primarily `GazeTracking.tsx`.

---

## 🧠 Core Component: `GazeTracking.tsx`

This file is the engine of the application. It handles the eye-tracking lifecycle, signal processing, and the continuous Bayesian update loop. Below is a breakdown of its internal logic:

### 1. State Management & Interfaces

The component manages two distinct types of state:

- **React State:** Handles UI updates (active key highlighting, text input, calibration status).
- **Ref State (`useRef`):** Handles high-frequency data that changes every frame (30-60Hz) to avoid React render cycle overhead. This includes:
  - **`KeyDef`**: Static properties (Label, ID, Special roles).
  - **`KeyState`**: Dynamic properties used for the Bayesian calculation:
    - `interest`: The accumulated "dwell" probability mass.
    - `selectionCount`: Used to update Priors (frequency of use).
    - `prior`: The probability of a key being pressed based on past history.
    - `rect`: Cached DOM coordinates for efficient hit-testing.

### 2. Input Layer (GazeCloudAPI)

The component bridges the React lifecycle with the external `GazeCloudAPI`.

- **Initialization**: Injects the API script and manages the calibration UI overlay.
- **Data Flow**: Receives raw `(x, y)` screen coordinates via the `OnResult` callback.

### 3. Smoothing Layer (Signal Processing)

Because webcam-based eye tracking contains significant jitter ("noise"), raw data must be smoothed before processing.

- **Algorithm**: Weighted Exponential Moving Average (EMA).
- **Baseline Configuration**:
  - `GAZE_HISTORY_SIZE = 8`: Uses a large buffer of past frames.
  - `GAZE_SMOOTHING_ALPHA = 0.15`: Uses a low alpha, resulting in heavy smoothing. This makes the cursor stable but less responsive (laggy) compared to velocity-aware methods.

### 4. Bayesian Inference Engine (The Math)

The core logic runs inside a `requestAnimationFrame` loop to ensure smooth performance. It calculates $P(Key | Gaze)$—the probability that the user wants to select a specific Key given their Gaze point.

1.  **Likelihood Calculation ($P(Gaze | Key)$):**

    - Models the user's gaze spread as a **Gaussian distribution**.
    - Calculates the distance between the smoothed gaze point and the center of every key.
    - Uses a fixed `SIGMA_RATIO` (0.5) to determine the "spread" of the gaze.

2.  **Prior Updates ($P(Key)$):**

    - Uses a Dirichlet-style update. Keys that are selected more frequently effectively become "larger" targets in the probability space.

3.  **Posterior Calculation & Interest Accumulation:**

    - **Normalization**: Converts likelihoods into probabilities that sum to 1.0 across all keys.
    - **Accumulation (The Baseline Flaw)**: In this traditional model, **every key** accumulates `interest` proportional to its posterior probability every frame. This leads to the "Midas Touch" problem where looking across the keyboard accidentally activates keys along the path.

4.  **Selection Trigger**:
    - When a key's accumulated `interest` exceeds `SELECTION_THRESHOLD` (1.0 seconds), a selection event is triggered.

### 5. Rendering & Feedback

- **Visuals**: Keys glow blue based on their current `interest` level.
- **Cursor**: A semi-transparent red cursor visualizes the smoothed gaze location.
- **Optimization**: Uses direct DOM manipulation via refs for high-performance animations, bypassing React's virtual DOM for the 60fps cursor updates.

---

## ⚙️ Configuration Constants (Baseline)

These parameters define the behavior of the "Control Group" implementation:

| Constant               | Value  | Description                                         |
| :--------------------- | :----- | :-------------------------------------------------- |
| `SIGMA_RATIO`          | `0.5`  | Standard deviation relative to key size.            |
| `SELECTION_THRESHOLD`  | `1.0`  | Requires 1.0s of focus to click (Standard Dwell).   |
| `GAZE_SMOOTHING_ALPHA` | `0.15` | High smoothing factor (results in sluggish cursor). |
| `PRIOR_K`              | `1.0`  | Dirichlet pseudocount for priors.                   |

## 🚀 Getting Started

1.  **Install Dependencies:**

    ```bash
    npm install
    ```

2.  **Run Development Server:**

    ```bash
    npm run dev
    ```

3.  **Usage:**
    - Grant camera permissions.
    - Follow the red dot for calibration.
    - **To Type**: Look at a key. The blue border indicates interest accumulation. Hold your gaze until the key flashes green.
    - **Correction**: Use the blank key next to Space for word suggestions.
