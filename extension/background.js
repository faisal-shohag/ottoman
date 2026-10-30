// Ottoman extension: connects to the Ottoman desktop app's local relay and speaks the Chrome DevTools Protocol for it.
// Tab-level commands go through chrome.debugger; the browser-level Target.* commands the app uses are mapped onto
// chrome.tabs, so the app's CDP code works unchanged. Agent tabs open in this profile's window, in an "Ottoman" group.

const RELAY = 'ws://127.0.0.1:47801/ext';
const GROUP_TITLE = 'Ottoman';

let ws = null;
let discover = false;
let agentTabId = null; // last tab the app worked in; new tabs open in its window
const attached = new Set();

function connect() {
  if (ws) return;
  const sock = new WebSocket(RELAY);
  ws = sock;
  sock.onmessage = (e) => handle(JSON.parse(e.data));
  sock.onclose = () => {
    if (ws === sock) ws = null;
    // The app went away: stop debugging so Chrome's "debugging this browser" bar disappears.
    for (const tabId of attached) chrome.debugger.detach({ tabId }).catch(() => {});
    attached.clear();
    discover = false;
  };
  sock.onerror = () => {};
}

const send = (msg) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

// Retry while the app is not running, and keep the service worker alive while it is.
chrome.alarms.create('ottoman-connect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => connect());
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
setInterval(() => (ws ? send({ method: 'Ottoman.ping' }) : connect()), 20000);
connect();

const info = (t) => ({
  targetId: String(t.id),
  type: 'page',
  title: t.title || '',
  url: t.url || t.pendingUrl || '',
  attached: attached.has(t.id),
  ...(t.openerTabId != null && { openerId: String(t.openerTabId) }),
});

async function agentWindow() {
  if (agentTabId != null) {
    const tab = await chrome.tabs.get(agentTabId).catch(() => null);
    if (tab) return tab.windowId;
  }
  const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  return win?.id;
}

async function addToGroup(tab) {
  const [group] = await chrome.tabGroups.query({ title: GROUP_TITLE, windowId: tab.windowId });
  if (group) return chrome.tabs.group({ tabIds: [tab.id], groupId: group.id });
  const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
  await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: 'green' });
}

const browserCommands = {
  'Target.setDiscoverTargets': async ({ discover: on }) => ((discover = !!on), {}),
  'Target.getTargets': async () => ({ targetInfos: (await chrome.tabs.query({})).map(info) }),
  'Target.getTargetInfo': async ({ targetId }) => ({ targetInfo: info(await chrome.tabs.get(Number(targetId))) }),
  'Target.createTarget': async ({ url }) => {
    const windowId = await agentWindow();
    // Chrome keeps running in the background after its last window closes; then a tab needs a new window.
    const tab = windowId != null
      ? await chrome.tabs.create({ url, active: true, windowId })
      : (await chrome.windows.create({ url, focused: true, type: 'normal' })).tabs[0];
    agentTabId = tab.id;
    await addToGroup(tab).catch(() => {}); // grouping is cosmetic
    return { targetId: String(tab.id) };
  },
  'Target.attachToTarget': async ({ targetId }) => {
    const tabId = Number(targetId);
    if (!attached.has(tabId)) {
      await chrome.debugger.attach({ tabId }, '1.3');
      attached.add(tabId);
    }
    return { sessionId: `tab-${tabId}` };
  },
  'Target.activateTarget': async ({ targetId }) => {
    const tab = await chrome.tabs.update(Number(targetId), { active: true });
    agentTabId = tab.id;
    await chrome.windows.update(tab.windowId, { focused: true });
    return {};
  },
  'Target.closeTarget': async ({ targetId }) => (await chrome.tabs.remove(Number(targetId)), { success: true }),
};

async function handle({ id, method, params = {}, sessionId }) {
  if (id === undefined) return;
  try {
    let result;
    if (sessionId) result = await chrome.debugger.sendCommand({ tabId: Number(sessionId.slice(4)) }, method, params);
    else if (browserCommands[method]) result = await browserCommands[method](params);
    else throw new Error(`${method} is not supported through the Ottoman extension`);
    send({ id, result: result ?? {} });
  } catch (e) {
    send({ id, error: { message: e?.message ?? String(e) } });
  }
}

chrome.tabs.onCreated.addListener((t) => discover && send({ method: 'Target.targetCreated', params: { targetInfo: info(t) } }));
chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  if (discover) send({ method: 'Target.targetDestroyed', params: { targetId: String(tabId) } });
});
chrome.debugger.onEvent.addListener((source, method, params) => {
  // Child sessions (out-of-process iframes) are not used by the app.
  if (source.tabId != null && !source.sessionId) send({ method, params, sessionId: `tab-${source.tabId}` });
});
chrome.debugger.onDetach.addListener((source, reason) => {
  attached.delete(source.tabId);
  send({ method: 'Target.detachedFromTarget', params: { sessionId: `tab-${source.tabId}`, targetId: String(source.tabId), reason } });
});
