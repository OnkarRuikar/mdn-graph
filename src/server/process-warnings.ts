import warnings from "../../data/warnings.json" with { type: "json" };
import nodes from "../../data/nodes.json" with { type: "json" };

const missingFeatures = new Set(
  (
    await Bun.file(
      Bun.fileURLToPath(
        import.meta.resolve("../../config/missing-features.txt")
      )
    ).text()
  )
    .split("\n")
    .filter((x) => x && !x.startsWith("  "))
    .map((x) => {
      // JS has no undocumented things
      if (x.startsWith("javascript.")) return;
      const [scope, interfac, member, ...rest] = x.split(".");
      if (rest.length) {
        console.error("Unexpected data:", x);
        return;
      }
      if (!member && scope !== "api" && scope !== "webassembly") {
        console.error("Unexpected data:", x);
        return;
      }
      switch (scope) {
        case "api":
          if (!member) return `/en-US/docs/Web/API/${interfac}`;
          return `/en-US/docs/Web/API/${interfac}/${member}`;
        case "css":
          return `/en-US/docs/Web/CSS/${member}`;
        case "http":
          if (interfac === "headers") {
            return `/en-US/docs/Web/HTTP/Headers/${member}`;
          }
          break;
        case "webdriver":
          if (interfac === "commands") {
            return `/en-US/docs/Web/WebDriver/Commands/${member}`;
          }
          break;
        case "webassembly":
          // Not structured enough
          return;
      }
      console.error("Unexpected data:", x);
    })
);

const noPageRec = new Map(
  (
    await Bun.file(
      Bun.fileURLToPath(import.meta.resolve("../../config/no-page.txt"))
    ).text()
  )
    .split("\n")
    .filter((x) => x && !x.startsWith("  "))
    .map((x) => [x, false])
);

for (const node of nodes) {
  if (Object.keys(node.data.metadata.flaws).length === 0) continue;
  const nodeWarnings = (warnings[node.data.metadata.source.folder] ??= []);
  Object.entries(node.data.metadata.flaws).forEach(([id, data]) => {
    data.forEach((d) => {
      if (id === "broken_links") {
        const correspondingWarning = nodeWarnings.find(
          (w) =>
            w.message === "Broken link" &&
            w.data[0] === d.href.replace(/#.+/, "") &&
            w.data.at(-1) !== "(and flaw)"
        );
        if (correspondingWarning) {
          correspondingWarning.data.push("(and flaw)");
          return;
        }
        if (d.explanation !== "Link points to the page it's already on") {
          console.error("Broken link not caught by warnings:", d.href);
        }
      } else if (id === "macros") {
        if (d.explanation.endsWith("does not exist")) {
          const url = d.explanation.replace(" does not exist", "");
          if (missingFeatures.has(url)) return;
          else if (noPageRec.has(url)) {
            noPageRec.set(url, true);
            return;
          }
        }
      } else if (id === "images") {
        if (
          d.explanation === "External image URL" &&
          d.src.startsWith("https://mdn.github.io/shared-assets")
        ) {
          return;
        }
      }
      nodeWarnings.push({
        message: "Flaw",
        data: [id, d.macroName, d.explanation],
      });
    });
  });
}

async function checkLink(href: string) {
  if (href.startsWith("http:")) {
    try {
      const res = await fetch(href.replace("http:", "https:"), {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        return {
          type: "HTTP link",
          data: "has HTTPS alternative",
        };
      }
    } catch {}
  }
  try {
    const res = await fetch(href, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      return {
        type: "error status",
        data: res.status,
      };
    }
    if (res.url !== href) {
      return {
        type: "redirected",
        data: res.url,
      };
    } else if (href.startsWith("http:")) {
      return {
        type: "HTTP link",
        data: "",
      };
    } else {
      return {
        type: "ok",
      };
    }
  } catch (e) {
    return {
      type: "request error",
      data: (e as Error).message,
    };
  }
}

const linkRequests: (() => Promise<void>)[] = [];
const checkedLinks = new Map<
  string,
  { type: string; data?: any } | undefined
>();

function report(node, ...data) {
  const nodeWarnings = (warnings[node.data.metadata.source.folder] ??= []);
  nodeWarnings.push({
    message: data[0],
    data: data.slice(1),
  });
}

// Copied from BCD
const bugLinkShorteners: [RegExp, string][] = [
  [
    /^https?:\/\/bugzilla\.mozilla\.org\/show_bug\.cgi\?id=(\d+)/g,
    "https://bugzil.la/$1",
  ],
  [
    /^https?:\/\/(issues\.chromium\.org)\/issues\/(\d+)/g,
    "https://crbug.com/$2",
  ],
  [
    /^https?:\/\/(bugs\.chromium\.org|code\.google\.com)\/p\/chromium\/issues\/detail\?id=(\d+)/g,
    "https://crbug.com/$2",
  ],
  [
    /^https?:\/\/(bugs\.chromium\.org|code\.google\.com)\/p\/((?!chromium)\w+)\/issues\/detail\?id=(\d+)/g,
    "https://crbug.com/$2/$3",
  ],
  [
    /^https?:\/\/chromium\.googlesource\.com\/chromium\/src\/\+\/([\w\d]+)/g,
    "https://crrev.com/$1",
  ],
  [
    /^https?:\/\/bugs\.webkit\.org\/show_bug\.cgi\?id=(\d+)/g,
    "https://webkit.org/b/$1",
  ],
];

for (const node of nodes) {
  for (const link of node.data.links) {
    if (/^https:\/\/(jsfiddle\.net|codepen\.io|jsbin\.com)\/./.test(link)) {
      report(node, "External sandbox link", link);
      continue;
    }
    const bugLinkShortener = bugLinkShorteners.find(([prefix]) =>
      prefix.test(link)
    );
    if (bugLinkShortener) {
      report(
        node,
        "Unshortened bug link",
        link,
        "replace with",
        link.replace(...bugLinkShortener)
      );
      continue;
    }
    if (
      [
        // Sites that don't do redirects or break links, should save us some time
        "https://stackoverflow.com",
        "https://tc39.es",
        "https://drafts.csswg.org",
        "https://unicode.org",
        "https://www.unicode.org",
        "https://datatracker.ietf.org",
        "https://github.com/tc39",
        "https://github.com/w3c",
        "https://github.com/whatwg",
        "https://bugzil.la",
        "https://webkit.org/b/",
        "https://crbug.com",
        "https://crrev.com",
        "https://caniuse.com",
        "https://chromestatus.com",
        "https://chromium.googlesource.com",
        // Youtube uses queries, so there's no real 404
        "https://www.youtube.com",
        "https://youtu.be",
        "https://www.wolframalpha.com/input",
        // Is this safe?
        "https://www.w3.org",
        "https://www.npmjs.com",
      ].some((domain) => link.startsWith(domain)) ||
      link.includes(".spec.whatwg.org")
    ) {
      continue;
    }
    if (link.startsWith("http")) {
      const url = new URL(link);
      url.hash = "";
      const href = url.href;
      if (!checkedLinks.has(href)) {
        checkedLinks.set(href, undefined);
        linkRequests.push(() =>
          checkLink(href).then((res) => {
            checkedLinks.set(href, res);
          })
        );
      }
    }
  }
}

// Every time, parallel at most 25 requests, wait until any of them settles,
// remove it from the queue and pull in the next one
async function depleteQueue() {
  if (linkRequests.length <= 25) {
    await Promise.all(linkRequests.map((req) => req()));
    return;
  }
  let curReq = 25;
  const promisePool: Promise<number>[] = [];
  for (let i = 0; i < 25; i++) {
    promisePool.push(linkRequests[i]().then(() => i));
  }
  while (curReq < linkRequests.length) {
    if (curReq % 100 === 0 || linkRequests.length - curReq < 100) {
      console.log(`Processed ${curReq}/${linkRequests.length} links`);
    }
    const completedSlot = await Promise.race(promisePool);
    promisePool[completedSlot] = linkRequests[curReq++]().then(
      () => completedSlot
    );
  }
  await Promise.all(promisePool);
  console.log(`Processed ${curReq}/${linkRequests.length} links`);
}

if (!Bun.argv.includes("--no-external-link-check")) {
  await depleteQueue();
} else {
  console.warn("Skipping external link check");
}

for (const node of nodes) {
  for (const link of node.data.links) {
    if (!link.startsWith("http")) continue;
    const url = new URL(link);
    url.hash = "";
    const checked = checkedLinks.get(url.href);
    if (!checked) continue;
    if (checked.type === "ok") continue;
    switch (checked.type) {
      case "HTTP link":
        report(node, "HTTP link", url.href, checked.data);
        break;
      case "error status":
        report(node, "Broken external link", url.href, checked.data);
        break;
      case "redirected":
        report(node, "Redirected external link", url.href, checked.data);
        break;
      case "request error":
        report(node, "Broken external link", url.href, checked.data);
        break;
      default:
        console.error("Unexpected checked link type:", checked);
        break;
    }
  }
}

const warningList = Object.entries(warnings);
warningList.sort(([a], [b]) =>
  a.replaceAll("/", "").localeCompare(b.replaceAll("/", ""))
);

const brokenAnchors = Bun.file("broken-anchors.txt");
Bun.write(brokenAnchors, "");
const brokenAnchorsWriter = brokenAnchors.writer();

for (const [nodeId, messages] of warningList) {
  if (nodeId.includes("/mozilla/") || messages.length === 0) continue;
  for (const { message, data } of messages) {
    if (message === "Broken anchor") {
      brokenAnchorsWriter.write(
        `files/${nodeId}/index.md\t${
          data.length === 1
            ? [nodeId.replace(/^en-us/, "/en-us/docs"), ...data].join("")
            : data.join("")
        }\n`
      );
    }
  }
}

const tree = { children: {}, slug: "" };

for (const [nodeId, baseMessages] of warningList) {
  const messages = baseMessages.filter(
    (x) =>
      !(
        // Caused by broken macros which are reported
        (
          x.message === "Missing href" ||
          (x.message === "Broken link" &&
            (missingFeatures.has(x.data[0]) ||
              (noPageRec.has(x.data[0]) &&
                (noPageRec.set(x.data[0], true), true))))
        )
      )
  );
  if (nodeId.includes("/mozilla/") || messages.length === 0) continue;
  const parts = nodeId.split("/");
  let current = tree;
  for (const part of parts) {
    current = current.children[part] ??= { children: {} };
  }
  current.slug = nodeId;
  current.messages = messages;
}

Bun.write("data/warnings-processed.json", JSON.stringify(tree, null, 2));

brokenAnchorsWriter.end();

for (const [url, used] of noPageRec) {
  if (!used) {
    console.error(`${url} is no longer referenced`);
  }
}
