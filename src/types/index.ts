export type KeyDef = {
  id: string;
  label: string;
  value?: string;
  wide?: boolean;
  special?: boolean;
  fullWidth?: boolean;
  role?: "space-left" | "space-suggest";
};

export interface GazeCloudAPI {
  StartEyeTracking: () => void;
  StopEyeTracking: () => void;
  UseClickRecalibration: boolean;
  OnResult?: (data: any) => void;
  OnCalibrationComplete?: () => void;
  OnCamDenied?: () => void;
  OnError?: (msg: string) => void;
}

export interface WindowType {
  StopEyeTracking(): unknown;
  UseClickRecalibration: boolean;
  OnError: (msg: any) => void;
  OnCamDenied: () => void;
  OnCalibrationComplete: () => void;
  StartEyeTracking(): unknown;
  OnResult: (GazeData: any) => void;
  GazeCloudAPI: GazeCloudAPI;
}

export interface KeyState {
  interest: number;
  selectionCount: number;
  prior: number;
  rect: DOMRect | null;
  // Track posterior for hysteresis
  lastPosterior: number;
}