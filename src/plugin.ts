import streamDeck, { LogLevel } from "@elgato/streamdeck";

import { MusicDial } from "./actions/dial";
import { audioBridge } from "./audio-bridge";

streamDeck.logger.setLevel(LogLevel.DEBUG);
streamDeck.logger.info("musicvol plugin started.");

streamDeck.actions.registerAction(new MusicDial());
streamDeck.connect();

for (const signal of ["SIGINT", "SIGTERM", "exit"] as const) {
	process.on(signal, () => audioBridge.dispose());
}
