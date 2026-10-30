chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
chrome.action.onClicked.addListener((tab) => {
  if (tab.id && /^https?:/.test(tab.url || '')) chrome.storage.local.set({ pagepressTabId: tab.id });
});
