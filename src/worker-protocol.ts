export type WorkerRequest =
  | { type: 'start'; targetMatrixSize: number }
  | { type: 'frame'; pixels: ImageData }
  | { type: 'stop' };

export type WorkerDiagnostics = {
  frames: number;
  pixels: number;
  packets: number;
  invalidPackets: number;
};

export type WorkerResponse =
  | { type: 'packet'; frameId: number; session: number; decodedCount: number; blockCount: number; solved: number; name?: string }
  | { type: 'frameDone'; timestamp: number; counts: WorkerDiagnostics }
  | { type: 'diagnostic'; code: string; counts: WorkerDiagnostics }
  | { type: 'complete'; bytes: Uint8Array; name: string; mime: string; expectedHash: string; verified: true; unique: number; solved: number }
  | { type: 'error'; message: string };
