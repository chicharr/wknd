
// TODO we shouldn't need to specify all the sheets
const FILE_PATH = '/drafts/chicharr/martech.json?sheet=default&sheet=adobe';

export async function loadMartechLazy(context) {
  loadMartech((delayed) => delayed && "no" === delayed.toLowerCase(), context);
}

export async function loadMartechDelayed(context) {
  loadMartech((delayed) => !delayed || "no" !== delayed.toLowerCase(), context);
}

async function loadMartech(delayedCondition, {sampleRUM, toCamelCase}) {
  Object.entries(await getNeutrinoConfig(toCamelCase))
  .filter(([k, v]) => delayedCondition(v.delayed))
  .forEach( async ([k, v]) => {
    console.log(`Load martech ${k}`);
    const {script} = v;
    if (!script) {
      return;
    }
    script.startsWith('http') ? loadExternalScript(script, v) : await import(script).then((m) => m.default({sampleRUM, ...v}));
  });
}

const neutrinoConfig = {};
async function getNeutrinoConfig(toCamelCase) {
  if (neutrinoConfig) {
    return neutrinoConfig;
  }

  const resp = await fetch(FILE_PATH);
  if (resp.status !== 200) {
    console.error("Error reading neutrino configuration");
    return;
  }
  const json = await resp.json();
  json.default.data.forEach((line) => {
    if(window.location.href.match(line['Path'])) {
      Object.assign(neutrinoConfig, Object.fromEntries(line['Active Martech'].split(',')
                                      .map((n) => n.trim())
                                      .filter((n) => json[n])
                                      .map((n) => [n, parseConfig(json[n].data, toCamelCase)])));
    }
  });
  return neutrinoConfig;
}



function parseConfig(data, toCamelCase, env = 'Prod') {
  const config = {};
  if (!data) return;
  data.forEach((prop) => {
    config[toCamelCase(prop.Property)] = prop[env];
  });
  return config;
}

function loadExternalScript (script, config) {
  // TODO replace possible variables in script url
  const scriptElement = document.createElement('script');
  script.src = script;
  document.head.appendChild(script);
  return true;
}

