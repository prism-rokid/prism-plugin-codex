"use strict";

const { createStdioServer } = require("@rokid-prism/pluginbridge-plugin-sdk");
const { CdpPageClient } = require("@rokid-prism/pluginbridge-plugin-sdk/cdp-runtime");
const fs = require("node:fs");
const path = require("node:path");
const { createDotAdapter } = require("./adapter.cjs");
const { createDesktopBackend } = require("./desktop.cjs");
const { PluginAdapterError, compatibleOutput } = require("./stdio.cjs");
const { createDeliveryLedger } = require("./delivery-ledger.cjs");

const installedHostModule = path.join(__dirname, "shared", "desktop-host.cjs");
const hostModule = fs.existsSync(installedHostModule) ? installedHostModule : "../shared/desktop-host.cjs";
const { windowLeasePath, readWindowLease, navigationExpression, withDesktopHostLock } = require(hostModule);
const { dotNavigation } = require("./navigation.cjs");
const leasePath = windowLeasePath("dot");
const readDotWindowLease = (options) => readWindowLease(leasePath, options);
const navigateToDot = (id) => dotNavigation(id, navigationExpression);
const backend = createDesktopBackend({ readDotWindowLease, navigateToDot, withDesktopHostLock, CdpPageClient, PluginAdapterError });
const ledger = createDeliveryLedger(path.join(path.dirname(leasePath), "dot-delivery.sqlite"));

const output = compatibleOutput(process.stdout);
createStdioServer(createDotAdapter({ backend, PluginAdapterError, ledger }), process.stdin, output).run().catch((error) => {
  process.stderr.write(`Dot plugin failed: ${error.name}\n`);
  process.exitCode = 1;
});
