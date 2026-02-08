import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./App.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  // Note: StrictMode disabled - causes issues with Agentick client lifecycle
  // See: https://github.com/agentick/agentick/issues/XXX
  <App />,
);
