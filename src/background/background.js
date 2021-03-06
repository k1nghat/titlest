import browser from "webextension-polyfill";
import store from "../store";

// https://github.com/mozilla/webextension-polyfill/issues/74#issuecomment-406289372
browser.menus = browser.menus || browser.contextMenus;
// clear persisted context menus: https://stackoverflow.com/a/38204762/934239
// create the right click context menu item
browser.menus.removeAll();
browser.menus.create({
	id: "test",
	title: "add hostname to Titlest",
	contexts: ["page"],
});
// browser.contextMenus.removeAll(() => {
// 	browser.contextMenus.create({
// 		title: "change/append title (Alt+Shift+N)",
// 		id: "addHost",
// 		type: "normal",
// 		contexts: ["page"],
// 	});
// });

// listeners for action context menu or keyboard shorcut
browser.commands.onCommand.addListener(async (command) => {
	try {
		if (command === "add-host") {
			const tab = await browser.tabs.query({
				currentWindow: true,
				active: true,
			});
			await setHost(tab[0]);
			notification(tab[0]);
		}
	} catch (error) {
		console.log(`LOG: command -> error: `, error);
	}
});
browser.menus.onClicked.addListener(async (info, tab) => {
	await setHost(tab);
	notification(tab);
});

store.subscribe((mutation, state) => {
	if (mutation.type === "vweReplaceState") reloadInit();
});

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (message.type === "updateTabs") updateTabs(message);
	if (message.type === "setTabsToGlobalState") setTabsToGlobalState();
	if (message.type === "updateSavedTabs") reloadInit();
});

browser.tabs.onUpdated.addListener(handleUpdatedTabs);

async function reloadInit() {
	try {
		const tabs = await browser.tabs.query({});

		clearOriginalTabTitles(tabs);

		for (const tab of tabs) {
			const hostName = new URL(tab.url).hostname;
			const host = store.getters["hosts/getHostByHostName"](hostName);

			if (host) {
				setOriginalTabTitle(tab, host);
			}
			if (host && host.hostState) {
				const loopCheck = preventDocumentLoops(tab, host);
				if (loopCheck) {
					setTabTitle(tab, host);
				}
			}
		}
	} catch (error) {
		console.log(`LOG: reloadInit -> error: `, error);
	}
}

async function setTabsToGlobalState() {
	try {
		const tabs = await browser.tabs.query({});

		for (const tab of tabs) {
			const hostName = new URL(tab.url).hostname;
			const host = store.getters["hosts/getHostByHostName"](hostName);

			if (host && host.hostState) {
				const title = await formatTabTitle(tab, host);
				browser.tabs.executeScript(tab.id, {
					code: `document.title = "${title}";`,
				});
				// setTabTitle(tab, host);
			}
		}
	} catch (error) {
		console.log(`LOG: setTabsToGlobalState -> error: `, error);
	}
}

async function clearOriginalTabTitles(tabs) {
	try {
		for (const tab of tabs) {
			const hostName = new URL(tab.url).hostname;
			const host = store.getters["hosts/getHostByHostName"](hostName);

			if (host) {
				const { title } = tab;
				const { userTitle } = host;

				if (title !== userTitle) {
					store.dispatch("hosts/setHostProperty", {
						mutation: "SET_ORIGINAL_TAB_TITLE",
						value: {},
						host,
					});
				}
			}
		}
	} catch (error) {
		console.log(`LOG: clearOriginalTabTitles -> error: `, error);
	}
}

async function setOriginalTabTitle(tab, host) {
	try {
		if (tab.title !== host.userTitle) {
			const { title, id } = tab;
			const { userTitle, originalTabTitles } = host;
			const originalTabTitle = title.replace(`${userTitle}`, "");

			await store.dispatch("hosts/setHostProperty", {
				mutation: "SET_ORIGINAL_TAB_TITLE",
				value: {
					...originalTabTitles,
					[id]: originalTabTitle,
				},
				host,
			});
		}
	} catch (error) {
		console.log(`LOG: setOriginalTabTitle -> error: `, error);
	}
}

function getOriginalTabTitle(tab, host) {
	const originalTabTitle = host.originalTabTitles[tab.id];
	return originalTabTitle;
}

async function updateTabs(payload) {
	try {
		const { host } = payload;
		const tabs = await browser.tabs.query({
			url: `*://${payload.host.hostName}/*`,
		});

		for (const tab of tabs) {
			if (payload.action === "setTabsToOriginalTabTitles") {
				const originalTabTitle = getOriginalTabTitle(tab, host);

				browser.tabs.executeScript(tab.id, {
					code: `document.title = "${originalTabTitle}";`,
				});
				// setTabTitle(tab, host);
			} else {
				const loopCheck = preventDocumentLoops(tab, host);
				if (loopCheck) {
					setTabTitle(tab, host);
				}
			}
		}
	} catch (error) {
		console.log(`LOG: updateTabs -> error: `, error);
	}
}

async function handleUpdatedTabs(tabId, changeInfo, tabInfo) {
	try {
		if (changeInfo.title) {
			const hostName = new URL(tabInfo.url).hostname;
			const host = store.getters["hosts/getHostByHostName"](hostName);

			if (!host) return;

			setOriginalTabTitle(tabInfo, host);

			const loopCheck = preventDocumentLoops(tabInfo, host);
			const globalState = await getGlobalState();

			if (host.hostState && loopCheck && globalState) {
				const title = await formatTabTitle(tabInfo, host);

				browser.tabs.executeScript(tabId, {
					code: `document.title = "${title}";`,
				});
			}
		}
	} catch (error) {
		console.log(`LOG: handleUpdatedTabs -> error: `, error);
	}
}

async function setTabTitle(tab, host) {
	try {
		const title = await formatTabTitle(tab, host);
		const globalState = await getGlobalState();

		if (globalState) {
			browser.tabs.executeScript(tab.id, {
				code: `document.title = "${title}";`,
			});
		}
	} catch (error) {
		console.log(`LOG: setTabTitle -> error: `, error);
	}
}

async function formatTabTitle(tab, host) {
	try {
		const { userTitle, isAppended, originalTabTitles, hostState } = host;
		const originalTabTitle = getOriginalTabTitle(tab, host);
		const globalState = await getGlobalState();
		let formattedTitle;

		if (hostState)
			formattedTitle = isAppended ? originalTabTitle + userTitle : userTitle;
		if (!hostState || !globalState) formattedTitle = originalTabTitle;

		return formattedTitle;
	} catch (error) {
		console.log(`LOG: formatTabTitle -> error: `, error);
	}
}

function preventDocumentLoops(tab, host) {
	if (!host) return;

	const { isAppended, originalTabTitles, userTitle, hostState } = host;
	const { title, id } = tab;

	if (hostState) {
		if (isAppended && title === `${originalTabTitles[id]}${userTitle}`)
			return;
		if (!isAppended && title === userTitle) return;
	}

	return true;
}

async function getGlobalState() {
	try {
		const state = await store.state.globals.options.globalState;

		return state;
	} catch (error) {
		console.log(`LOG: getGlobalState -> error: `, error);
	}
}

async function setHost(tab) {
	try {
		const hostName = new URL(tab.url).hostname;
		const host = store.getters["hosts/getHostByHostName"](hostName);
		if (!host) {
			const hostObject = {
				id: tab.id,
				date: undefined,
				hostState: true,
				hostName,
				userTitle: " - Titlest",
				originalTabTitles: {},
				isAppended: true,
				hostBindings: [],
			};

			await store.dispatch("hosts/setHost", hostObject);
			reloadInit();
		}
	} catch (error) {
		console.log(`LOG: setHost -> error: `, error);
	}
}

function notification(tab) {
	const hostName = new URL(tab.url).hostname;

	browser.notifications.create({
		type: "basic",
		iconUrl: tab.favIconUrl,
		title: "Hostname added:",
		message: `${hostName} has been added to Titlest.`,
	});
}
