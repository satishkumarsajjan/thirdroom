import { GameState } from "../GameThread";

export interface GameThreadModule<ModuleState> {
  create(): ModuleState;
  init: (state: GameState) => Promise<void>;
  dispose?: (state: GameState) => void;
}
