import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { PlayerChat } from "./components/PlayerChat.js";
import { chatTicketId } from "./lib/router.js";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("The page is missing its #root element.");
// `/chat/<ticket>`: a player's support chat, which Downhill shows in a frame. Everything else is the wall.
const chat = chatTicketId(window.location.pathname);
createRoot(container).render(<StrictMode>{chat !== undefined ? <PlayerChat ticketId={chat} /> : <App />}</StrictMode>);
