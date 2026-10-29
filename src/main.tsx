import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

// No StrictMode: its double-run effects would launch Chrome and open two Gemini sessions.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
