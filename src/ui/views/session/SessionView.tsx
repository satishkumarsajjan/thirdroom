import { useEffect, useRef } from "react";
import { Outlet } from "react-router-dom";
import { DndProvider } from "react-dnd";
import { HTML5Backend } from "react-dnd-html5-backend";
import { useAtomValue, useSetAtom } from "jotai";

import "./SessionView.css";
import { useInitMainThreadContext, MainThreadContextProvider } from "../../hooks/useMainThread";
import { Overlay } from "./overlay/Overlay";
import { StatusBar } from "./statusbar/StatusBar";
import { LoadingScreen } from "../components/loading-screen/LoadingScreen";
import { useHomeWorld } from "../../hooks/useHomeWorld";
import { useUnknownWorldPath } from "../../hooks/useWorld";
import { useAutoJoinRoom } from "../../hooks/useAutoJoinRoom";
import { useHydrogen } from "../../hooks/useHydrogen";
import config from "../../../../config.json";
import { overlayWorldAtom } from "../../state/overlayWorld";
import { overlayVisibilityAtom } from "../../state/overlayVisibility";

export default function SessionView() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mainThread = useInitMainThreadContext(canvasRef);
  const { session } = useHydrogen(true);
  const overlayVisible = useAtomValue(overlayVisibilityAtom);
  const [worldId, worldAlias] = useUnknownWorldPath();
  const homeWorldId = useHomeWorld();
  const selectWorld = useSetAtom(overlayWorldAtom);
  useAutoJoinRoom(session, config.repositoryRoomIdOrAlias);

  useEffect(() => {
    if (!worldId && !worldAlias && homeWorldId) {
      selectWorld(homeWorldId);
    }
  }, [worldId, worldAlias, homeWorldId, selectWorld]);

  return (
    <DndProvider backend={HTML5Backend}>
      <div className="SessionView">
        <canvas className="SessionView__viewport" ref={canvasRef} />
        {mainThread ? (
          <MainThreadContextProvider value={mainThread}>
            <Outlet />
            {overlayVisible && <Overlay />}
            <StatusBar />
          </MainThreadContextProvider>
        ) : (
          <LoadingScreen message="Initializing engine..." />
        )}
      </div>
    </DndProvider>
  );
}
