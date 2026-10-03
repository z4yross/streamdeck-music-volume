import streamDeck, {
	action,
	type DialAction,
	type DialDownEvent,
	type DialRotateEvent,
	type DialUpEvent,
	type DidReceiveSettingsEvent,
	SingletonAction,
	type TouchTapEvent,
	type WillAppearEvent,
	type WillDisappearEvent,
} from "@elgato/streamdeck";

import { type AppStatus, audioBridge, type TransportCommand } from "../audio-bridge";
import { colorFor, iconFor } from "../icons";

export type Settings = {
	/** Comma-separated process names in priority order. */
	apps?: string;
	/** Percent per dial tick. */
	step?: number;
	/** Poll interval in seconds. */
	refreshSeconds?: number;
};

const DEFAULT_APPS = "Spotify,Deezer";
const DEFAULT_STEP = 3;
const DEFAULT_REFRESH = 1;
/** Touch strip canvas is 200px wide; left half is previous, right half is next. */
const TOUCH_WIDTH = 200;
/** Dial press held at least this long toggles mute instead of play/pause. */
const HOLD_MS = 400;

const logger = streamDeck.logger.createScope("Dial");

type DialState = {
	status: AppStatus;
	/** Optimistic volume shown while a `set` is in flight, 0..1. */
	localVolume: number | null;
	setInFlight: boolean;
	/** Volume the user asked for after the in-flight `set` was sent; flushed when it returns. */
	dirty: boolean;
	/** Album art currently shown, keyed by track so it is fetched once per song. */
	artKey: string | null;
	artUri: string | null;
	artInFlight: boolean;
	/** When the dial went down, to tell a short press from a hold on release. */
	downAt: number | null;
	/** Rotating while pressed is its own gesture; the release must not also play/pause. */
	rotatedWhilePressed: boolean;
};

function describe(status: AppStatus): string {
	if (!status.found) return "nothing";
	const track = status.track ? ` "${status.track.title}" by ${status.track.artist} [${status.track.playback}]` : "";
	return `${status.exe} (vol=${Math.round(status.volume * 100)}% mute=${status.mute})${track}`;
}

function parseApps(settings: Settings): string[] {
	return (settings.apps ?? DEFAULT_APPS)
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * One dial that follows whichever music player is open.
 *
 * The candidate is picked by the PowerShell helper from the priority list: the first
 * app with an audio session wins, unless a lower one is the one actually playing.
 * Rotating changes that app's session volume. A short press toggles play/pause, a held
 * press toggles mute. Tapping the touch strip skips: left half previous, right half next.
 * Transport commands go through the app's own SMTC session, so they hit the player the
 * dial follows rather than whatever Windows considers the current media app.
 *
 * Rotation is coalesced: the display updates on every tick from a local copy of the
 * volume, but only one `set` command is ever in flight. When it returns and more ticks
 * arrived meanwhile, the latest value is sent once. That keeps a fast spin from
 * queueing dozens of 200ms round-trips behind each other.
 */
@action({ UUID: "com.z4yross.musicvol.dial" })
export class MusicDial extends SingletonAction<Settings> {
	private timer: NodeJS.Timeout | null = null;
	private refreshing = false;
	private states = new Map<string, DialState>();

	private stateFor(id: string): DialState {
		let state = this.states.get(id);
		if (!state) {
			state = {
				status: { found: false },
				localVolume: null,
				setInFlight: false,
				dirty: false,
				artKey: null,
				artUri: null,
				artInFlight: false,
				downAt: null,
				rotatedWhilePressed: false,
			};
			this.states.set(id, state);
		}
		return state;
	}

	private async paint(dial: DialAction<Settings>, state: DialState): Promise<void> {
		const { status } = state;
		if (!status.found) {
			await dial.setFeedback({
				icon: iconFor(null, false),
				app: "",
				track: "No player",
				artist: "",
				bar: { value: 0, bar_fill_c: colorFor(null, false) },
			});
			return;
		}

		const volume = state.localVolume ?? status.volume;
		const percent = Math.round(volume * 100);
		const level = status.mute ? "MUTE" : `${percent}%`;
		const paused = status.track && status.track.playback !== "playing" ? " · paused" : "";

		const wantedArtKey = status.track?.artKey ?? null;
		const art = wantedArtKey && wantedArtKey === state.artKey ? state.artUri : null;

		await dial.setFeedback({
			icon: art ?? iconFor(status.exe, status.mute),
			app: `${status.exe} · ${level}${paused}`,
			// Players without SMTC metadata fall back to showing their own name big.
			track: status.track?.title || status.exe,
			artist: status.track?.artist ?? "",
			bar: { value: percent, bar_fill_c: colorFor(status.exe, status.mute) },
		});
	}

	private async refresh(dial: DialAction<Settings>, settings: Settings): Promise<void> {
		const state = this.stateFor(dial.id);
		// A poll landing mid-spin would overwrite the optimistic value with a stale one.
		if (state.setInFlight || state.dirty) return;

		try {
			const previous = state.status;
			state.status = await audioBridge.status(parseApps(settings));
			state.localVolume = null;
			// Only on change: this runs every second, and the log has to stay readable.
			if (describe(previous) !== describe(state.status)) logger.info(`now following ${describe(state.status)}`);
			void this.ensureArt(dial, state);
		} catch (error) {
			logger.error("status failed", error);
			state.status = { found: false };
		}
		await this.paint(dial, state);
	}

	/** Fetches album art when the track changed; paints again once it lands. */
	private async ensureArt(dial: DialAction<Settings>, state: DialState): Promise<void> {
		const { status } = state;
		const wanted = status.found ? (status.track?.artKey ?? null) : null;
		if (wanted === state.artKey || state.artInFlight || !status.found) return;

		state.artInFlight = true;
		try {
			const art = await audioBridge.art(status.exe);
			state.artKey = art.key;
			state.artUri = art.key && art.data ? `data:${art.mime ?? "image/png"};base64,${art.data}` : null;
			logger.info(`art ${state.artUri ? `loaded (${Math.round((art.data?.length ?? 0) * 0.75 / 1024)} KB)` : "unavailable"} for ${art.key ?? "no track"}`);
			await this.paint(dial, state);
		} catch (error) {
			logger.error("art fetch failed", error);
			state.artKey = wanted;
			state.artUri = null;
		} finally {
			state.artInFlight = false;
		}
	}

	private async refreshAll(): Promise<void> {
		// A slow helper answer (app quitting mid-call) must not stack a second poll on top.
		if (this.refreshing) return;
		this.refreshing = true;
		try {
			for (const dial of this.actions) {
				if (!dial.isDial()) continue;
				const settings = await dial.getSettings();
				await this.refresh(dial, settings);
			}
		} finally {
			this.refreshing = false;
		}
	}

	private startTimer(seconds: number): void {
		this.stopTimer();
		this.timer = setInterval(() => {
			void this.refreshAll().catch((error) => logger.error("refresh failed", error));
		}, Math.max(0.5, seconds) * 1000);
	}

	private stopTimer(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	/** Sends the current local volume; loops while ticks keep arriving during the round-trip. */
	private async flushVolume(dial: DialAction<Settings>, state: DialState): Promise<void> {
		if (state.setInFlight || !state.status.found || state.localVolume === null) return;
		const exe = state.status.exe;

		state.setInFlight = true;
		try {
			// Ticks that land during the round-trip set `dirty` again; loop until the last one lands.
			while (state.dirty) {
				state.dirty = false;
				state.status = await audioBridge.setVolume(exe, state.localVolume);
				if (!state.status.found) break;
			}
			// The helper's answer is now authoritative; drop the optimistic copy.
			state.localVolume = null;
			state.dirty = false;
		} catch (error) {
			logger.error("set volume failed", error);
			state.localVolume = null;
			state.dirty = false;
		} finally {
			state.setInFlight = false;
		}
		await this.paint(dial, state);
	}

	override async onWillAppear(ev: WillAppearEvent<Settings>): Promise<void> {
		if (!ev.action.isDial()) return;
		logger.info(`willAppear ${ev.action.id}`);
		await this.refresh(ev.action, ev.payload.settings);
		this.startTimer(ev.payload.settings.refreshSeconds ?? DEFAULT_REFRESH);
	}

	override onWillDisappear(ev: WillDisappearEvent<Settings>): void {
		this.states.delete(ev.action.id);
		if (this.states.size === 0) this.stopTimer();
	}

	override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<Settings>): Promise<void> {
		if (!ev.action.isDial()) return;
		this.startTimer(ev.payload.settings.refreshSeconds ?? DEFAULT_REFRESH);
		await this.refresh(ev.action, ev.payload.settings);
	}

	override async onDialRotate(ev: DialRotateEvent<Settings>): Promise<void> {
		const state = this.stateFor(ev.action.id);
		if (!state.status.found) return;

		if (ev.payload.pressed) state.rotatedWhilePressed = true;
		const step = (ev.payload.settings.step ?? DEFAULT_STEP) / 100;
		const base = state.localVolume ?? state.status.volume;
		state.localVolume = Math.min(1, Math.max(0, base + ev.payload.ticks * step));
		state.dirty = true;

		await this.paint(ev.action, state);
		void this.flushVolume(ev.action, state);
	}

	override onDialDown(ev: DialDownEvent<Settings>): void {
		const state = this.stateFor(ev.action.id);
		state.downAt = Date.now();
		state.rotatedWhilePressed = false;
	}

	override async onDialUp(ev: DialUpEvent<Settings>): Promise<void> {
		const state = this.stateFor(ev.action.id);
		const held = state.downAt !== null && Date.now() - state.downAt >= HOLD_MS;
		const rotated = state.rotatedWhilePressed;
		state.downAt = null;
		state.rotatedWhilePressed = false;
		if (rotated) return;
		if (held) await this.toggleMute(ev.action);
		else await this.transport(ev.action, "playpause");
	}

	override async onTouchTap(ev: TouchTapEvent<Settings>): Promise<void> {
		const [x] = ev.payload.tapPos;
		await this.transport(ev.action, x < TOUCH_WIDTH / 2 ? "prev" : "next");
	}

	private async transport(dial: DialAction<Settings>, command: TransportCommand): Promise<void> {
		const state = this.stateFor(dial.id);
		if (!state.status.found) return;
		logger.info(`${command} -> ${state.status.exe}`);
		try {
			state.status = await audioBridge.control(state.status.exe, command);
		} catch (error) {
			logger.error(`${command} failed`, error);
			await dial.showAlert();
			return;
		}
		// Track changes land a beat later; the poll picks them up, this just shows play/pause now.
		await this.paint(dial, state);
	}

	private async toggleMute(dial: DialAction<Settings>): Promise<void> {
		const state = this.stateFor(dial.id);
		if (!state.status.found) return;
		try {
			state.status = await audioBridge.toggleMute(state.status.exe);
		} catch (error) {
			logger.error("toggle mute failed", error);
			await dial.showAlert();
			return;
		}
		await this.paint(dial, state);
	}
}
