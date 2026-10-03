import streamDeck from "@elgato/streamdeck";

import { MusicDial } from "./actions/dial";
import { audioBridge } from "./audio-bridge";

streamDeck.logger.setLevel("debug");
// SDK 3 defaults to the 7.1 settings lifecycle; the legacy one keeps Stream Deck 6.9+ supported.
streamDeck.settings.useLegacySettingsBehavior = true;
streamDeck.logger.info("musicvol plugin started.");

streamDeck.actions.registerAction(new MusicDial());
streamDeck.connect();

for (const signal of ["SIGINT", "SIGTERM", "exit"] as const) {
	process.on(signal, () => audioBridge.dispose());
}
