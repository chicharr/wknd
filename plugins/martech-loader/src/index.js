// TODO path to the config file
// TODO we shouldn't need to specify the sheets that we want to retrieve
const FILE_PATH = '/drafts/neutrino/martech.json?sheet=default&sheet=adobeanalytics&sheet=google&sheet=adobelaunch';

function parseConfig(data, toCamelCase) {
  let env = 'Live';
  if (window.location.hostname === 'localhost') {
    env = 'Dev';
  } else if (window.location.hostname.endsWith('.hlx.page')) {
    env = 'Page';
  }
  const config = {};
  if (data) {
    data.forEach((prop) => {
      config[toCamelCase(prop.Property)] = prop[env];
    });
  }
  return config;
}

let pendingConsentMartech = [];
// keep the config of neutrino in a var to avoid loading and parsing the info twice
let neutrinoConfig;
async function getNeutrinoConfig(toCamelCase) {
  if (neutrinoConfig) {
    return neutrinoConfig;
  }
  const resp = await fetch(FILE_PATH);
  if (resp.status !== 200) {
    console.error(`Error reading neutrino configuration ${FILE_PATH}`);
    return {};
  }
  const json = await resp.json();
  neutrinoConfig = {};
  json.default.data.forEach((line) => {
    if (window.location.href.match(line.Path)) {
      Object.assign(neutrinoConfig, Object.fromEntries(line['Active Martech'].split(',')
        .map((n) => n.trim())
        .filter((n) => json[n])
        .map((n) => [n, parseConfig(json[n].data, toCamelCase)])));
    }
  });
  return neutrinoConfig;
}

// eslint-disable-next-line no-unused-vars
function loadExternalScript(document, script, config) {
  // TODO replace possible variables in script url
  const scriptElement = document.createElement('script');
  scriptElement.src = script;
  document.head.appendChild(scriptElement);
  return true;
}

function initPartytown(forwardedEvents, pluginOptions) {
  const pluginUrl = pluginOptions.url || '/plugins/src/martech-loader/src/index.js';
  window.partytown = {
    lib: pluginUrl.replace('/index.js', '/partytown/'),
    forward: ['dataLayer.push', ...forwardedEvents],
  };
  import('./partytown/partytown.js');
}

function isConsented(key, config) {
  const consentEnabled = !!(window.hlx && window.hlx.consent);
  const consentedCategories = consentEnabled ? window.hlx.consent.categories : [];
  const isConsented = !consentEnabled ||
     !config.consentCategory ||
     (consentedCategories && consentedCategories.includes(config.consentCategory));
  if (!isConsented) {
    console.log(`[martech-loader] prevent load martech ${key} -> not consented`);
    pendingConsentMartech.push({key, config});
  }
  return isConsented;
}

function consentUpdated(document, context, pluginOptions) {
  console.log(`[martech-loader] consent updated: ${window.hlx.consent.categories}`);
  if (!pendingConsentMartech || !pendingConsentMartech.length) {
    return;
  }
  const { sampleRUM, toCamelCase, getPlaceholderOrDefault } = context;
  const webworkerEvents = [];
  const pendingArray = new Array(...pendingConsentMartech);
  pendingConsentMartech = [];
  let loadWebworker = false;
  pendingArray.filter(({key, config}) => isConsented(key, config))
    .forEach(({k, v}) => {
      console.log(`[martech-loader] Load martech ${k}`);
      loadWebworker = loadWebworker || (v.webworker && v.webworker.toLowerCase()==='yes');
      if (v.webworker && v.webworker.toLowerCase('yes') && v.webworkerForwardEvents) {
        webworkerEvents.push(...v.webworkerForwardEvents.split(',').map((e) => e.trim()));
      }
      const { script } = v;
      if (script.startsWith('http')) {
        loadExternalScript(document, script, v);
      } else {
        import(script).then((m) => m.default({ sampleRUM, getPlaceholderOrDefault, ...v }));
      }
    });
  if (loadWebworker) {
    initPartytown(webworkerEvents, pluginOptions);
  }
}

async function loadMartech(delayedCondition, document, context, pluginOptions) {
  const { sampleRUM, toCamelCase, getPlaceholderOrDefault } = context;
  const webworkerEvents = [];
  let loadWebworker = false;
  Object.entries(await getNeutrinoConfig(toCamelCase))
    .filter(([, v]) => delayedCondition(v.delayed) && v.script)
    .filter(([k, v]) => isConsented(k, v))
    .forEach(([k, v]) => {
      console.log(`[martech-loader] Load martech ${k}`);
      loadWebworker = loadWebworker || (v.webworker && v.webworker.toLowerCase()==='yes');
      if (v.webworker && v.webworker.toLowerCase('yes') && v.webworkerForwardEvents) {
        webworkerEvents.push(...v.webworkerForwardEvents.split(',').map((e) => e.trim()));
      }
      const { script } = v;
      if (script.startsWith('http')) {
        loadExternalScript(document, script, v);
      } else {
        import(script).then((m) => m.default({ sampleRUM, getPlaceholderOrDefault, ...v }));
      }
    });
  if (loadWebworker) {
    initPartytown(webworkerEvents, pluginOptions);
  }
}

/**
 * Load the martech configured as non-delayed
 * @param {*} context should contain at lease sampleRUM object and toCamelCase function
 */
export async function loadEager(document, pluginOptions, context) {
  document.addEventListener('consent-updated', () => { console.log('[martech-loader] consent-updated');consentUpdated(document, context, pluginOptions);});
  document.addEventListener('consent', () => consentUpdated(document, context, pluginOptions));
  getNeutrinoConfig(context.toCamelCase).then((nconfig) => Object.values(nconfig)
    .filter((v) => v.script && !v.script.startsWith('http') && v.earlyInit)
    .forEach((v) => import(v.script).then((m) => m.eagerInit && m.eagerInit())));
}

/**
 * Load the martech configured as non-delayed
 * @param {*} context should contain at lease sampleRUM object and toCamelCase function
 */
export async function loadLazy(document, pluginOptions, context) {
  loadMartech((delayed) => delayed && delayed.toLowerCase() === 'no', document, context, pluginOptions);
}

/**
 * Load the martech configured as delayed
 * @param {*} context should contain at lease sampleRUM object and toCamelCase function
 */
export async function loadDelayed(document, pluginOptions, context) {
  loadMartech((delayed) => !delayed || delayed.toLowerCase() !== 'no', document, context, pluginOptions);
}
