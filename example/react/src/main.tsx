import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./App.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  // Note: StrictMode disabled - causes issues with Tentickle client lifecycle
  // See: https://github.com/tentickle/tentickle/issues/XXX
  <App />,
);
