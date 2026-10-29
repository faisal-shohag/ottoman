// WebSocket opened from Rust (tauri-plugin-websocket). Unlike the webview's own WebSocket it sends no Origin header,
// which a user's running Chrome requires: it rejects page origins and cannot be restarted with --remote-allow-origins.
import WebSocket from '@tauri-apps/plugin-websocket';
import type { OpenSocket } from './cdp';

export const tauriSocket: OpenSocket = async (url, onMessage, onClose) => {
  // Accessibility trees and screenshots can be large. A number, not 'none': the plugin's Rust side (2.5.0) rejects 'none'.
  const MAX = 256 * 1024 * 1024;
  const ws = await WebSocket.connect(url, { maxMessageSize: MAX, maxFrameSize: MAX }).catch((e) => {
    throw new Error(`Cannot connect to Chrome: ${e}`);
  });
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      onClose();
    }
  };
  ws.addListener((m) => {
    if (m.type === 'Text') onMessage(m.data);
    else if (m.type === 'Close') close();
  });
  return {
    send: (text) => void ws.send(text).catch(close),
    close: () => void ws.disconnect().catch(() => {}).finally(close),
  };
};
