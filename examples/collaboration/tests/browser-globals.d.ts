export {};
declare global { interface Window {
  originalCellEditor: Element | null;
  motionSample: Promise<{ frames: number[]; unrelatedMutations: number; samePointer: boolean; sameParticipant: boolean }>;
  dragMotionSample: Promise<{ frames: { x: number; separation: number }[]; sameRing: boolean }>;
  flowMotion: Promise<{ y: number; separation: number }[]>;
} }
