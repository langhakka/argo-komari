#!/usr/bin/env node

const http = require("http");
const crypto = require("crypto");
const axios = require("axios");
const os = require('os');
const fs = require("fs");
const path = require("path");
const { promisify } = require('util');
const exec = promisify(require('child_process').exec);
const spawn = require('child_process').spawn;
const UPLOAD_URL = process.env.UPLOAD_URL || '';      // 节点或订阅自动上传地址,需填写部署Merge-sub项目后的首页地址,例如：https://merge.xxx.com
const PROJECT_URL = process.env.PROJECT_URL || '';    // 需要上传订阅或保活时需填写项目分配的url,例如：https://google.com
const AUTO_ACCESS = process.env.AUTO_ACCESS || false; // false关闭自动保活，true开启,需同时填写PROJECT_URL变量
const FILE_PATH = process.env.FILE_PATH || '.tmp';   // 运行目录,sub节点文件保存目录
const SUB_PATH = process.env.SUB_PATH || 'sub';       // 订阅路径
const PORT = process.env.SERVER_PORT || process.env.PORT || 3000;        // http服务订阅端口
const UUID = process.env.UUID || (() => {
  if (!fs.existsSync(FILE_PATH)) {
    fs.mkdirSync(FILE_PATH, { recursive: true });
  }
  const uuidFile = path.join(FILE_PATH, '.uuid');
  if (fs.existsSync(uuidFile)) {
    return fs.readFileSync(uuidFile, 'utf-8').trim();
  }
  const newUuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = crypto.randomBytes(1)[0] % 16;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
  fs.writeFileSync(uuidFile, newUuid);
log('info', `Generated UUID: ${newUuid}`);
	  return newUuid;
})(); // 留空自动生成UUID并持久化保存
const KOMARI_SERVER = process.env.KOMARI_SERVER || '';        // komari 服务器地址，格式：https://www.mydomain.com（不需要端口和路径）
const KOMARI_KEY = process.env.KOMARI_KEY || '';              // komari 自动发现密钥
const ARGO_DOMAIN = process.env.ARGO_DOMAIN || '';          // 固定隧道域名,留空即启用临时隧道
const ARGO_AUTH = process.env.ARGO_AUTH || '';              // 固定隧道密钥json或token,留空即启用临时隧道,json获取地址：https://json.zone.id
const ARGO_PORT = process.env.ARGO_PORT || 8001;            // 固定隧道端口,使用token需在cloudflare后台设置和这里一致
const CFIP = process.env.CFIP || 'saas.sin.fan';            // 节点优选域名或优选ip  
const CFPORT = process.env.CFPORT || 443;                   // 节点优选域名或优选ip对应的端口
const NAME = process.env.NAME || '';                        // 节点名称
const LOG_LEVEL = process.env.LOG_LEVEL || 'node';           // 日志级别: debug/node/info/error

// 日志函数，按级别控制输出
const log = (level, ...args) => {
  const levels = { debug: 0, node: 1, info: 2, error: 3 };
  if (levels[level] >= levels[LOG_LEVEL]) {
    if (level === 'error') {
      console.error(...args);
    } else {
      console.log(...args);
    }
  }
};

// 创建运行文件夹
if (!fs.existsSync(FILE_PATH)) {
  fs.mkdirSync(FILE_PATH);
log('info', `${FILE_PATH} is created`);
	} else {
	  log('info', `${FILE_PATH} already exists`);
}

// 生成随机6位字符
function generateRandomName() {
  const characters = 'abcdefghijklmnopqrstuvwxyz';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
}

// 全局常量
let subContent = null;
const komariName = generateRandomName();
const webName = generateRandomName();
const botName = generateRandomName();
let komariPath = path.join(FILE_PATH, komariName);
let webPath = path.join(FILE_PATH, webName);
let botPath = path.join(FILE_PATH, botName);
let subPath = path.join(FILE_PATH, 'sub.txt');
let listPath = path.join(FILE_PATH, 'list.txt');
let bootLogPath = path.join(FILE_PATH, 'boot.log');
let configPath = path.join(FILE_PATH, 'config.json');

// 如果订阅器上存在历史运行节点则先删除
function deleteNodes() {
  try {
    if (!UPLOAD_URL) return;
    if (!fs.existsSync(subPath)) return;

    let fileContent;
    try {
      fileContent = fs.readFileSync(subPath, 'utf-8');
    } catch {
      return null;
    }

    const decoded = Buffer.from(fileContent, 'base64').toString('utf-8');
    const nodes = decoded.split('\n').filter(line =>
      /(vless|vmess|trojan|hysteria2|tuic):\/\//.test(line)
    );

    if (nodes.length === 0) return;

    axios.post(`${UPLOAD_URL}/api/delete-nodes`,
      JSON.stringify({ nodes }),
      { headers: { 'Content-Type': 'application/json' } }
    ).catch((error) => {
      return null;
    });
    return null;
  } catch (err) {
    return null;
  }
}

// 清理历史文件（保留.uuid和sub.txt）
function cleanupOldFiles() {
  try {
    const files = fs.readdirSync(FILE_PATH);
    const keepFiles = new Set(['.uuid', 'sub.txt']);
    files.forEach(file => {
      if (keepFiles.has(file)) return;
      const filePath = path.join(FILE_PATH, file);
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
          fs.unlinkSync(filePath);
        }
      } catch (err) {
        // 忽略所有错误，不记录日志
      }
    });
  } catch (err) {
    // 忽略所有错误，不记录日志
  }
}

// 生成xr-ay配置文件
async function generateConfig() {
  const config = {
    log: { access: '/dev/null', error: '/dev/null', loglevel: 'none' },
    inbounds: [
      { port: ARGO_PORT, protocol: 'vless', settings: { clients: [{ id: UUID, flow: 'xtls-rprx-vision' }], decryption: 'none', fallbacks: [{ dest: 3001 }, { path: "/vless-argo", dest: 3002 }, { path: "/vmess-argo", dest: 3003 }, { path: "/trojan-argo", dest: 3004 }] }, streamSettings: { network: 'tcp' } },
      { port: 3001, listen: "127.0.0.1", protocol: "vless", settings: { clients: [{ id: UUID }], decryption: "none" }, streamSettings: { network: "tcp", security: "none" } },
      { port: 3002, listen: "127.0.0.1", protocol: "vless", settings: { clients: [{ id: UUID, level: 0 }], decryption: "none" }, streamSettings: { network: "ws", security: "none", wsSettings: { path: "/vless-argo" } }, sniffing: { enabled: true, destOverride: ["http", "tls", "quic"], metadataOnly: false } },
      { port: 3003, listen: "127.0.0.1", protocol: "vmess", settings: { clients: [{ id: UUID, alterId: 0 }] }, streamSettings: { network: "ws", wsSettings: { path: "/vmess-argo" } }, sniffing: { enabled: true, destOverride: ["http", "tls", "quic"], metadataOnly: false } },
      { port: 3004, listen: "127.0.0.1", protocol: "trojan", settings: { clients: [{ password: UUID }] }, streamSettings: { network: "ws", security: "none", wsSettings: { path: "/trojan-argo" } }, sniffing: { enabled: true, destOverride: ["http", "tls", "quic"], metadataOnly: false } },
    ],
    dns: { servers: ["https+local://8.8.8.8/dns-query"] },
    outbounds: [{ protocol: "freedom", tag: "direct" }, { protocol: "blackhole", tag: "block" }]
  };
  fs.writeFileSync(path.join(FILE_PATH, 'config.json'), JSON.stringify(config, null, 2));
}

// 判断系统架构
function getSystemArchitecture() {
  const arch = os.arch();
  if (arch === 'arm' || arch === 'arm64' || arch === 'aarch64') {
    return 'arm';
  } else {
    return 'amd';
  }
}

// 下载对应系统架构的依赖文件
function downloadFile(fileName, fileUrl, callback) {
  const filePath = fileName;

  if (!fs.existsSync(FILE_PATH)) {
    fs.mkdirSync(FILE_PATH, { recursive: true });
  }

  const writer = fs.createWriteStream(filePath);

  axios({
    method: 'get',
    url: fileUrl,
    responseType: 'stream',
  })
    .then(response => {
      response.data.pipe(writer);

      writer.on('finish', () => {
        writer.close();
        log('info', `Download ${path.basename(filePath)} successfully`);
        callback(null, filePath);
      });

      writer.on('error', err => {
        fs.unlink(filePath, () => { });
        const errorMessage = `Download ${path.basename(filePath)} failed: ${err.message}`;
        console.error(errorMessage);
        callback(errorMessage);
      });
    })
    .catch(err => {
      const errorMessage = `Download ${path.basename(filePath)} failed: ${err.message}`;
      console.error(errorMessage);
      callback(errorMessage);
    });
}

// 下载并运行依赖文件
async function downloadFilesAndRun() {
  const architecture = getSystemArchitecture();
  const filesToDownload = getFilesForArchitecture(architecture);

  if (filesToDownload.length === 0) {
    log('info', `Can't find a file for the current architecture`);
    return;
  }

  const downloadPromises = filesToDownload.map(fileInfo => {
    return new Promise((resolve, reject) => {
      downloadFile(fileInfo.fileName, fileInfo.fileUrl, (err, filePath) => {
        if (err) {
          reject(err);
        } else {
          resolve(filePath);
        }
      });
    });
  });

  try {
    await Promise.all(downloadPromises);
  } catch (err) {
    console.error('Error downloading files:', err);
    return;
  }

  function authorizeFiles(filePaths) {
    const newPermissions = 0o775;
    filePaths.forEach(absoluteFilePath => {
      if (fs.existsSync(absoluteFilePath)) {
        fs.chmod(absoluteFilePath, newPermissions, (err) => {
          if (err) {
            console.error(`Empowerment failed for ${absoluteFilePath}: ${err}`);
          } else {
            log('info', `Empowerment success for ${absoluteFilePath}: ${newPermissions.toString(8)}`);
          }
        });
      }
    });
  }
  const filesToAuthorize = [komariPath, webPath, botPath];
  authorizeFiles(filesToAuthorize);

  // 运行komari agent
  if (KOMARI_SERVER && KOMARI_KEY) {
    const endpoint = KOMARI_SERVER.replace(/\/+$/, '');

    try {
      const komari = spawn(komariPath, [
        '--endpoint', endpoint,
        '--auto-discovery', KOMARI_KEY,
        '--disable-auto-update',
        '--protocol-version', '2',
        '--interval', '3'
      ], { stdio: 'ignore' });

      komari.on('error', (err) => {
        console.error(`komari agent spawn error: ${err.message}`);
      });
      komari.on('exit', (code) => {
        log('info', `komari agent exited with code ${code}`);
      });

      log('info', `komari agent started -> ${endpoint}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (error) {
      console.error(`komari agent start error: ${error}`);
    }
  } else {
    log('info', 'KOMARI_SERVER or KOMARI_KEY is empty, skip running komari agent');
  }

  // 运行xr-ay
  try {
    const web = spawn(webPath, ['-c', `${FILE_PATH}/config.json`], { stdio: 'ignore' });

    web.on('error', (err) => {
      console.error(`web spawn error: ${err.message}`);
    });
    web.on('exit', (code) => {
      log('info', `web exited with code ${code}`);
    });

    log('info', `${webName} is running`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } catch (error) {
    console.error(`web start error: ${error}`);
  }

  // 运行cloud-fared
  if (fs.existsSync(botPath)) {
    let args;

    if (ARGO_AUTH.match(/^[A-Z0-9a-z=]{120,250}$/)) {
      args = ['tunnel', '--edge-ip-version', 'auto', '--no-autoupdate', '--protocol', 'http2', 'run', '--token', ARGO_AUTH];
    } else if (ARGO_AUTH.match(/TunnelSecret/)) {
      args = ['tunnel', '--edge-ip-version', 'auto', '--config', `${FILE_PATH}/tunnel.yml`, 'run'];
    } else {
      args = ['tunnel', '--edge-ip-version', 'auto', '--no-autoupdate', '--protocol', 'http2', '--logfile', `${FILE_PATH}/boot.log`, '--loglevel', 'info', '--url', `http://localhost:${ARGO_PORT}`];
    }

    try {
      const bot = spawn(botPath, args, { stdio: 'ignore' });

      bot.on('error', (err) => {
        console.error(`cloudflared spawn error: ${err.message}`);
      });
      bot.on('exit', (code) => {
        log('info', `cloudflared exited with code ${code}`);
      });

      log('info', `${botName} is running`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } catch (error) {
      console.error(`cloudflared start error: ${error}`);
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

// 根据系统架构返回对应的url
function getFilesForArchitecture(architecture) {
  let baseFiles;

  if (architecture === 'arm') {
    baseFiles = [
      { fileName: webPath, fileUrl: "https://arm64.ssss.nyc.mn/web" },
      { fileName: botPath, fileUrl: "https://arm64.ssss.nyc.mn/bot" },
      { fileName: komariPath, fileUrl: `https://github.com/komari-monitor/komari-agent/releases/latest/download/komari-agent-linux-arm64` }
    ];
  } else {
    baseFiles = [
      { fileName: webPath, fileUrl: "https://amd64.ssss.nyc.mn/web" },
      { fileName: botPath, fileUrl: "https://amd64.ssss.nyc.mn/bot" },
      { fileName: komariPath, fileUrl: `https://github.com/komari-monitor/komari-agent/releases/latest/download/komari-agent-linux-amd64` }
    ];
  }

  return baseFiles;
}

// 获取固定隧道json
function argoType() {
  if (!ARGO_AUTH || !ARGO_DOMAIN) {
    log('info', "ARGO_DOMAIN or ARGO_AUTH is empty, use quick tunnels");
    return;
  }

  if (ARGO_AUTH.includes('TunnelSecret')) {
    fs.writeFileSync(path.join(FILE_PATH, 'tunnel.json'), ARGO_AUTH);
    const tunnelYaml = `
  tunnel: ${ARGO_AUTH.split('"')[11]}
  credentials-file: ${path.join(FILE_PATH, 'tunnel.json')}
  protocol: http2
  
  ingress:
    - hostname: ${ARGO_DOMAIN}
      service: http://localhost:${ARGO_PORT}
      originRequest:
        noTLSVerify: true
    - service: http_status:404
  `;
    fs.writeFileSync(path.join(FILE_PATH, 'tunnel.yml'), tunnelYaml);
  } else {
    log('info', `Using token connect to tunnel, please set ${ARGO_PORT} in clouudflare`);
  }
}

// 获取临时隧道domain
async function extractDomains(retries = 30) {
  let argoDomain;

  if (ARGO_AUTH && ARGO_DOMAIN) {
    argoDomain = ARGO_DOMAIN;
    log('info', 'ARGO_DOMAIN:', argoDomain);
    await generateLinks(argoDomain);
    return;
  }

  // 临时隧道：轮询等待 boot.log 中出现 trycloudflare 域名
  for (let i = 0; i < retries; i++) {
    try {
      if (!fs.existsSync(path.join(FILE_PATH, 'boot.log'))) {
        throw new Error('boot.log not found');
      }
      const fileContent = fs.readFileSync(path.join(FILE_PATH, 'boot.log'), 'utf-8');
      const lines = fileContent.split('\n');
      for (const line of lines) {
        const domainMatch = line.match(/https?:\/\/([^ ]*trycloudflare\.com)\/?/);
        if (domainMatch) {
          argoDomain = domainMatch[1];
          log('info', 'ArgoDomain:', argoDomain);
          await generateLinks(argoDomain);
          return;
        }
      }
      // 有文件但还没 domain，等一会再试
      log('debug', `Waiting for ArgoDomain... (${i + 1}/${retries})`);
    } catch (error) {
      log('debug', `Waiting for boot.log... (${i + 1}/${retries})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  console.error('Failed to obtain ArgoDomain after retries');
}

// 获取isp信息
async function getMetaInfo() {
  try {
    const response1 = await axios.get('https://api.ip.sb/geoip', { headers: { 'User-Agent': 'Mozilla/5.0', timeout: 3000 } });
    if (response1.data && response1.data.country_code && response1.data.isp) {
      return `${response1.data.country_code}-${response1.data.isp}`.replace(/\s+/g, '_');
    }
  } catch (error) {
    try {
      const response2 = await axios.get('http://ip-api.com/json', { headers: { 'User-Agent': 'Mozilla/5.0', timeout: 3000 } });
      if (response2.data && response2.data.status === 'success' && response2.data.countryCode && response2.data.org) {
        return `${response2.data.countryCode}-${response2.data.org}`.replace(/\s+/g, '_');
      }
    } catch (error) {
      // console.error('Backup API also failed');
    }
  }
  return 'Unknown';
}

// 生成 list 和 sub 信息
async function generateLinks(argoDomain) {
  const ISP = await getMetaInfo();
  const nodeName = NAME ? `${NAME}-${ISP}` : ISP;
  return new Promise((resolve) => {
    setTimeout(() => {
      const VMESS = { v: '2', ps: `${nodeName}`, add: CFIP, port: CFPORT, id: UUID, aid: '0', scy: 'auto', net: 'ws', type: 'none', host: argoDomain, path: '/vmess-argo?ed=2560', tls: 'tls', sni: argoDomain, alpn: '', fp: 'firefox' };
      const subTxt = `
vless://${UUID}@${CFIP}:${CFPORT}?encryption=none&security=tls&sni=${argoDomain}&fp=firefox&type=ws&host=${argoDomain}&path=%2Fvless-argo%3Fed%3D2560#${nodeName}

vmess://${Buffer.from(JSON.stringify(VMESS)).toString('base64')}

trojan://${UUID}@${CFIP}:${CFPORT}?security=tls&sni=${argoDomain}&fp=firefox&type=ws&host=${argoDomain}&path=%2Ftrojan-argo%3Fed%3D2560#${nodeName}
    `;
      log('node', Buffer.from(subTxt).toString('base64'));
      fs.writeFileSync(subPath, Buffer.from(subTxt).toString('base64'));
      log('info', `${FILE_PATH}/sub.txt saved successfully`);
      // 将订阅内容保存到全局变量，供 http 服务器使用
      subContent = Buffer.from(subTxt).toString('base64');
      uploadNodes();
      resolve(subTxt);
    }, 2000);
  });
}

// 自动上传节点或订阅
async function uploadNodes() {
  if (UPLOAD_URL && PROJECT_URL) {
    const subscriptionUrl = `${PROJECT_URL}/${SUB_PATH}`;
    const jsonData = {
      subscription: [subscriptionUrl]
    };
    try {
      const response = await axios.post(`${UPLOAD_URL}/api/add-subscriptions`, jsonData, {
        headers: {
          'Content-Type': 'application/json'
        }
      });

      if (response && response.status === 200) {
        log('info', 'Subscription uploaded successfully');
        return response;
      } else {
        return null;
      }
    } catch (error) {
      if (error.response) {
        if (error.response.status === 400) {
          // console.error('Subscription already exists');
        }
      }
    }
  } else if (UPLOAD_URL) {
    if (!fs.existsSync(listPath)) return;
    const content = fs.readFileSync(listPath, 'utf-8');
    const nodes = content.split('\n').filter(line => /(vless|vmess|trojan|hysteria2|tuic):\/\//.test(line));

    if (nodes.length === 0) return;

    const jsonData = JSON.stringify({ nodes });

    try {
      const response = await axios.post(`${UPLOAD_URL}/api/add-nodes`, jsonData, {
        headers: { 'Content-Type': 'application/json' }
      });
      if (response && response.status === 200) {
        log('info', 'Nodes uploaded successfully');
        return response;
      } else {
        return null;
      }
    } catch (error) {
      return null;
    }
  } else {
    // console.log('Skipping upload nodes');
    return;
  }
}

// 90s后删除相关文件（保留二进制以便进程持续运行）
function cleanFiles() {
  setTimeout(() => {
    const filesToDelete = [bootLogPath, configPath, webPath, botPath];

if (process.platform === 'win32') {
	      exec(`del /f /q ${filesToDelete.join(' ')} > nul 2>&1`, (error) => {
	        if (LOG_LEVEL !== 'error') console.clear();
	        log('info', 'App is running');
	        log('info', 'Thank you for using this script, enjoy!');
	      });
	    } else {
	      exec(`rm -rf ${filesToDelete.join(' ')} >/dev/null 2>&1`, (error) => {
	        if (LOG_LEVEL !== 'error') console.clear();
	        log('info', 'App is running');
	        log('info', 'Thank you for using this script, enjoy!');
	      });
	    }
  }, 90000);
}
cleanFiles();

// 自动访问项目URL
async function AddVisitTask() {
  if (!AUTO_ACCESS || !PROJECT_URL) {
    log('info', "Skipping adding automatic access task");
    return;
  }

  try {
    const response = await axios.post('https://oooo.serv00.net/add-url', {
      url: PROJECT_URL
    }, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
    log('info', `automatic access task added successfully`);
    return response;
  } catch (error) {
    console.error(`Add automatic access task faild: ${error.message}`);
    return null;
  }
}

// 主运行逻辑
async function startserver() {
  try {
    argoType();
    deleteNodes();
    cleanupOldFiles();
    await generateConfig();
    await downloadFilesAndRun();
    await extractDomains();
    await AddVisitTask();
  } catch (error) {
    console.error('Error in startserver:', error);
  }
}
startserver().catch(error => {
  console.error('Unhandled error in startserver:', error);
});

// 创建 http 服务器
const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];

  // 订阅路由
  if (urlPath === `/${SUB_PATH}`) {
    if (subContent) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(subContent);
    } else {
      // 订阅内容尚未生成，尝试从文件读取
      try {
        const fileContent = fs.readFileSync(subPath, 'utf-8');
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(fileContent);
      } catch (err) {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Subscription content not yet available, please try again later.');
      }
    }
    return;
  }

  // 根路由: /
  if (urlPath === '/') {
    try {
      const filePath = path.join(__dirname, 'index.html');
      const data = await fs.promises.readFile(filePath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    } catch (err) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end("Hello world!<br><br>You can access /{SUB_PATH}(Default: /sub) to get your nodes!");
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
});

server.listen(PORT, () => log('info', `http server is running on port:${PORT}!`));
