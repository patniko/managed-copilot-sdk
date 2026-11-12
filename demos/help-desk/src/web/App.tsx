import { useEffect } from "react";
import { CustomerPage } from "./components/Customer.js";
import { Header } from "./components/Header.js";
import { PlayerPage } from "./components/Player.js";
import { Toasts } from "./components/ui/Toasts.js";
import { Wall } from "./components/Wall.js";
import { useRoute } from "./lib/router.js";
import { startHelpDesk } from "./lib/store.js";

export function App() {
  const route = useRoute();
  useEffect(() => {
    startHelpDesk();
  }, []);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route]);
  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-fg">
      <Header />
      {route.kind === "customer" ? <CustomerPage id={route.id} /> : route.kind === "player" ? <PlayerPage id={route.id} /> : <Wall />}
      <Toasts />
    </div>
  );
}
