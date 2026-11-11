import { registerRootComponent } from "expo";
import App from "./src/App";
// Defines the Android background task in the global scope; see the file.
import "./src/background-task";

// Registers the app as "main" for Expo Go, development builds and the web.
registerRootComponent(App);
