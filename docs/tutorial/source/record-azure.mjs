// Records the deployed demos on Azure for the Azure chapter. Set AZURE_FACTORY_URL and AZURE_ASSISTANT_URL to your
// deployment's app URLs (docs/deployment.md); the apps only accept the IP ranges the deployment allows.
import { launch, Recorder, sleep } from "./common.mjs";

const factoryUrl = process.env.AZURE_FACTORY_URL;
const assistantUrl = process.env.AZURE_ASSISTANT_URL;
if (!factoryUrl || !assistantUrl) {
  console.error("Set AZURE_FACTORY_URL and AZURE_ASSISTANT_URL to the deployed apps (https://software-factory.<domain>, https://assistant.<domain>).");
  process.exit(1);
}
const { browser, context } = await launch();
const page = await context.newPage();
const rec = new Recorder(page, { fps: 12 });

try {
  await page.goto(`${factoryUrl}/#/`);
  await page.getByText("WORK ORDERS").first().waitFor({ timeout: 60_000 });
  await sleep(1500);
  await page.locator('a[href*="#/wo/"]').first().click();
  await sleep(3500);
  await rec.start("azure-factory");
  await sleep(6000);
  await rec.stop();

  await page.goto(assistantUrl);
  await page.locator('[data-testid="status"]').first().waitFor({ timeout: 60_000 });
  await sleep(3500);
  await rec.start("azure-assistant");
  await sleep(6000);
  await rec.stop();
  console.log("done");
} finally {
  await rec.stop().catch(() => undefined);
  await browser.close();
}
