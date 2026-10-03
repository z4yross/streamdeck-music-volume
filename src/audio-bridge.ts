import streamDeck from "@elgato/streamdeck";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const logger = streamDeck.logger.createScope("AudioBridge");

export type AppStatus =
	| { found: false }
	| {
			found: true;
			exe: string;
			/** 0..1 */
			volume: number;
			mute: boolean;
			playing: boolean;
			sessions: number;
			/** Now-playing metadata from SMTC; absent when the app does not publish it. */
			track?: { title: string; artist: string; album: string; playback: string; artKey: string | null } | null;
	  };

export type AlbumArt = { key: string | null; mime?: string; data?: string };

export type TransportCommand = "playpause" | "play" | "pause" | "next" | "prev";

type Pending = {
	resolve: (line: string) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
};

const REQUEST_TIMEOUT_MS = 8000;
const BRIDGE_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "audio-bridge.ps1");

/**
 * Owns the long-lived PowerShell helper that talks to WASAPI.
 *
 * Commands are strictly sequential: one line in, one JSON line out. A queue keeps
 * that invariant even when the dial fires several events before the first answer
 * comes back. If the helper dies it is respawned lazily on the next request.
 */
export class AudioBridge {
	private child: ChildProcessWithoutNullStreams | null = null;
	private queue: Pending[] = [];
	private buffer = "";

	async status(priority: string[]): Promise<AppStatus> {
		return this.request(`status ${priority.join(",")}`);
	}

	async setVolume(exe: string, volume: number): Promise<AppStatus> {
		const clamped = Math.min(1, Math.max(0, volume));
		return this.request(`set ${exe} ${clamped.toFixed(4)}`);
	}

	async toggleMute(exe: string): Promise<AppStatus> {
		return this.request(`mute ${exe} toggle`);
	}

	async control(exe: string, command: TransportCommand): Promise<AppStatus> {
		return this.request(`ctl ${exe} ${command}`);
	}

	async art(exe: string): Promise<AlbumArt> {
		return this.request(`art ${exe}`);
	}

	dispose(): void {
		this.child?.kill();
		this.child = null;
		this.failAll(new Error("bridge disposed"));
	}

	private async request<T>(command: string): Promise<T> {
		const child = this.ensureChild();
		const line = await new Promise<string>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.queue = this.queue.filter((p) => p.resolve !== resolve);
				// A hung helper poisons every later call; kill it so the next request respawns.
				logger.warn(`timeout on "${command}", restarting helper`);
				this.child?.kill();
				this.child = null;
				reject(new Error(`timeout: ${command}`));
			}, REQUEST_TIMEOUT_MS);
			this.queue.push({ resolve, reject, timer });
			child.stdin.write(`${command}\n`);
		});

		const parsed = JSON.parse(line) as T & { error?: string };
		if (parsed.error) throw new Error(parsed.error);
		return parsed;
	}

	private ensureChild(): ChildProcessWithoutNullStreams {
		if (this.child) return this.child;

		logger.info(`spawning helper: ${BRIDGE_SCRIPT}`);
		const child = spawn(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", BRIDGE_SCRIPT],
			{ stdio: "pipe", windowsHide: true },
		);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.onData(chunk));
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => logger.error(`helper stderr: ${chunk.trim()}`));
		child.on("exit", (code) => {
			logger.warn(`helper exited (code=${code})`);
			if (this.child === child) this.child = null;
			this.failAll(new Error("helper exited"));
		});
		child.on("error", (error) => {
			logger.error("helper spawn failed", error);
			if (this.child === child) this.child = null;
			this.failAll(error);
		});

		this.child = child;
		this.buffer = "";
		return child;
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let newline = this.buffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.buffer.slice(0, newline).trim();
			this.buffer = this.buffer.slice(newline + 1);
			if (line) {
				const pending = this.queue.shift();
				if (pending) {
					clearTimeout(pending.timer);
					pending.resolve(line);
				} else {
					logger.warn(`unsolicited helper output: ${line}`);
				}
			}
			newline = this.buffer.indexOf("\n");
		}
	}

	private failAll(error: Error): void {
		for (const pending of this.queue) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.queue = [];
	}
}

export const audioBridge = new AudioBridge();
