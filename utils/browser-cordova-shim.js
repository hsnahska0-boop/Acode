/**
 * Browser Cordova Shim for Acode
 *
 * Provides mock implementations of Cordova plugins so the Acode web UI
 * can render in a browser preview. File operations use an in-memory
 * virtual file system backed by localStorage.
 *
 * This is only loaded when Cordova is not present (browser preview).
 */

(function () {
  if (window.cordova) return; // Real Cordova present, do nothing

  // ─── Virtual File System (localStorage-backed) ───────────────────────────

  var VFS_KEY = "__acode_vfs__";
  var vfs = {};
  try {
    vfs = JSON.parse(localStorage.getItem(VFS_KEY) || "{}");
  } catch (e) {
    vfs = {};
  }

  function saveVfs() {
    try {
      localStorage.setItem(VFS_KEY, JSON.stringify(vfs));
    } catch (e) {
      // localStorage might be full; keep working in-memory
    }
  }

  function normalizePath(url) {
    // Convert file:// URLs to plain paths
    var path = url.replace(/^file:\/\/[^/]*\//, "/");
    path = decodeURIComponent(path);
    // Remove trailing slash (except root)
    if (path.length > 1 && path[path.length - 1] === "/") {
      path = path.slice(0, -1);
    }
    return path;
  }

  function toFileUrl(path) {
    return "file://localhost" + (path[0] === "/" ? path : "/" + path);
  }

  function basename(path) {
    var parts = path.split("/");
    return parts[parts.length - 1] || "";
  }

  function dirname(path) {
    var idx = path.lastIndexOf("/");
    if (idx <= 0) return "/";
    return path.slice(0, idx);
  }

  function joinPath() {
    var parts = [];
    for (var i = 0; i < arguments.length; i++) {
      var a = arguments[i];
      if (!a) continue;
      a = String(a).replace(/^file:\/\/[^/]*\//, "/");
      a = decodeURIComponent(a);
      if (a[0] === "/") a = a.slice(1);
      if (a) parts.push(a);
    }
    return "/" + parts.join("/");
  }

  function ensureDir(path) {
    if (!vfs[path]) {
      vfs[path] = { type: "dir", children: {} };
    }
    if (vfs[path].type !== "dir") return false;
    return true;
  }

  function ensureParents(path) {
    var parts = path.split("/").filter(Boolean);
    var cur = "";
    for (var i = 0; i < parts.length - 1; i++) {
      cur += "/" + parts[i];
      if (!vfs[cur]) {
        vfs[cur] = { type: "dir", children: {} };
      } else if (vfs[cur].type !== "dir") {
        return false;
      }
    }
    return true;
  }

  // ─── Mock Entry objects ──────────────────────────────────────────────────

  function createEntry(path) {
    var node = vfs[path];
    if (!node) return null;

    var entry = {
      isFile: node.type === "file",
      isDirectory: node.type === "dir",
      name: basename(path),
      fullPath: path,
      nativeURL: toFileUrl(path),
      filesystem: { name: "persistent", root: null },
    };

    if (node.type === "dir") {
      entry.createReader = function () {
        return {
          readEntries: function (success, error) {
            var children = [];
            Object.keys(node.children).forEach(function (childName) {
              var childPath = path === "/" ? "/" + childName : path + "/" + childName;
              var childEntry = createEntry(childPath);
              if (childEntry) children.push(childEntry);
            });
            success(children);
          },
        };
      };

      entry.getFile = function (name, options, success, error) {
        var childPath = joinPath(path, name);
        var exists = !!vfs[childPath];
        if (exists && options && options.create && options.exclusive) {
          error({ code: 12 }); // Path already exists
          return;
        }
        if (!exists && (!options || !options.create)) {
          error({ code: 1 }); // Not found
          return;
        }
        if (!exists) {
          ensureParents(childPath);
          vfs[childPath] = { type: "file", content: "", size: 0, modifiedDate: Date.now() };
          node.children[name] = true;
          saveVfs();
        }
        success(createEntry(childPath));
      };

      entry.getDirectory = function (name, options, success, error) {
        var childPath = joinPath(path, name);
        var exists = !!vfs[childPath];
        if (exists && options && options.create && options.exclusive) {
          error({ code: 12 });
          return;
        }
        if (!exists && (!options || !options.create)) {
          error({ code: 1 });
          return;
        }
        if (!exists) {
          ensureParents(childPath);
          vfs[childPath] = { type: "dir", children: {} };
          node.children[name] = true;
          saveVfs();
        }
        success(createEntry(childPath));
      };

      entry.removeRecursively = function (success, error) {
        // Delete all descendants
        var prefix = path === "/" ? "/" : path + "/";
        Object.keys(vfs).forEach(function (p) {
          if (p === path || p.indexOf(prefix) === 0) {
            delete vfs[p];
          }
        });
        // Remove from parent
        var parent = dirname(path);
        if (vfs[parent] && vfs[parent].children) {
          delete vfs[parent].children[basename(path)];
        }
        saveVfs();
        success();
      };

      entry.remove = function (success, error) {
        entry.removeRecursively(success, error);
      };
    }

    if (node.type === "file") {
      entry.createWriter = function (success, error) {
        var writer = {
          onwriteend: null,
          onerror: null,
          write: function (data) {
            var content;
            if (data instanceof Blob) {
              var reader = new FileReader();
              reader.onloadend = function () {
                var arr = Array.from(new Uint8Array(reader.result));
                vfs[path].content = arr;
                vfs[path].size = arr.length;
                vfs[path].modifiedDate = Date.now();
                saveVfs();
                if (writer.onwriteend) writer.onwriteend({});
              };
              reader.readAsArrayBuffer(data);
              return;
            }
            content = String(data);
            vfs[path].content = content;
            vfs[path].size = content.length;
            vfs[path].modifiedDate = Date.now();
            saveVfs();
            if (writer.onwriteend) writer.onwriteend({});
          },
          truncate: function (size) {
            if (writer.onwriteend) writer.onwriteend({});
          },
        };
        success(writer);
      };

      entry.file = function (success, error) {
        var content = vfs[path].content || "";
        var blob;
        if (Array.isArray(content)) {
          blob = new Blob([new Uint8Array(content)]);
        } else {
          blob = new Blob([content]);
        }
        success({
          name: basename(path),
          size: blob.size,
          type: "",
          lastModifiedDate: new Date(vfs[path].modifiedDate || Date.now()),
          slice: function () { return blob.slice.apply(blob, arguments); },
        });
      };

      entry.remove = function (success, error) {
        delete vfs[path];
        var parent = dirname(path);
        if (vfs[parent] && vfs[parent].children) {
          delete vfs[parent].children[basename(path)];
        }
        saveVfs();
        success();
      };

      entry.moveTo = function (destDir, newName, success, error) {
        var newPath = joinPath(destDir.fullPath, newName || basename(path));
        vfs[newPath] = vfs[path];
        delete vfs[path];
        var parent = dirname(path);
        if (vfs[parent] && vfs[parent].children) {
          delete vfs[parent].children[basename(path)];
        }
        if (vfs[destDir.fullPath] && vfs[destDir.fullPath].children) {
          vfs[destDir.fullPath].children[basename(newPath)] = true;
        }
        saveVfs();
        success(createEntry(newPath));
      };

      entry.copyTo = function (destDir, newName, success, error) {
        var newPath = joinPath(destDir.fullPath, newName || basename(path));
        vfs[newPath] = JSON.parse(JSON.stringify(vfs[path]));
        if (vfs[destDir.fullPath] && vfs[destDir.fullPath].children) {
          vfs[destDir.fullPath].children[basename(newPath)] = true;
        }
        saveVfs();
        success(createEntry(newPath));
      };
    }

    return entry;
  }

  // ─── window.resolveLocalFileSystemURL ────────────────────────────────────

  window.resolveLocalFileSystemURL = function (url, success, error) {
    var path = normalizePath(url);
    if (vfs[path]) {
      var entry = createEntry(path);
      if (entry) {
        success(entry);
        return;
      }
    }
    if (error) error({ code: 1 }); // Not found
  };

  // ─── cordova object ──────────────────────────────────────────────────────

  var STORAGE_BASE = "/data/data/com.foxdebug.acode";

  // Ensure base directories exist
  ensureParents(STORAGE_BASE + "/files");
  ensureParents(STORAGE_BASE + "/cache");
  ensureParents(STORAGE_BASE + "/files/plugins");
  if (!vfs[STORAGE_BASE + "/files"]) vfs[STORAGE_BASE + "/files"] = { type: "dir", children: {} };
  if (!vfs[STORAGE_BASE + "/cache"]) vfs[STORAGE_BASE + "/cache"] = { type: "dir", children: {} };
  if (!vfs[STORAGE_BASE + "/files/plugins"]) vfs[STORAGE_BASE + "/files/plugins"] = { type: "dir", children: {} };
  saveVfs();

  var ASSETS_DIR = "/android_asset/www";

  window.cordova = {
    file: {
      applicationDirectory: toFileUrl(ASSETS_DIR),
      applicationStorageDirectory: toFileUrl(STORAGE_BASE),
      dataDirectory: toFileUrl(STORAGE_BASE + "/files"),
      cacheDirectory: toFileUrl(STORAGE_BASE + "/cache"),
      externalDataDirectory: toFileUrl(STORAGE_BASE + "/external_files"),
      externalCacheDirectory: toFileUrl(STORAGE_BASE + "/external_cache"),
      externalRootDirectory: toFileUrl("/sdcard"),
      externalApplicationStorageDirectory: toFileUrl(STORAGE_BASE + "/external"),
      tempDirectory: toFileUrl(STORAGE_BASE + "/cache"),
      documentsDirectory: toFileUrl(STORAGE_BASE + "/files"),
      rootDirectory: toFileUrl("/"),
      root: null,
    },
    platform: "android",
    version: "1.13.5",
    exec: function (success, error, service, action, args) {
      // Mock cordova.exec for various plugins
      setTimeout(function () {
        handleExec(service, action, args || [], success, error);
      }, 0);
    },
    require: function (moduleId) {
      if (moduleId === "cordova/exec") {
        return window.cordova.exec;
      }
      return function () {};
    },
    define: function () {},
    callbackFromNative: function () {},
    callbackSuccess: function () {},
    callbackError: function () {},
    callbacks: {},
  };

  // ─── cordova.exec handler ─────────────────────────────────────────────────

  function handleExec(service, action, args, success, error) {
    // SDcard plugin
    if (service === "SDcard") {
      handleSdcard(action, args, success, error);
      return;
    }
    // Default: succeed with empty result
    if (success) success();
  }

  function handleSdcard(action, args, success, error) {
    switch (action) {
      case "stats": {
        var path = normalizePath(args[0]);
        if (vfs[path]) {
          success({
            name: basename(path),
            url: toFileUrl(path),
            canRead: true,
            canWrite: true,
            isFile: vfs[path].type === "file",
            isDirectory: vfs[path].type === "dir",
            isLink: false,
            size: vfs[path].type === "file" ? (vfs[path].size || 0) : 0,
            modifiedDate: vfs[path].modifiedDate || Date.now(),
          });
        } else {
          if (error) error({ code: 1 });
        }
        break;
      }
      case "exists": {
        var p = normalizePath(args[0]);
        success(!!vfs[p]);
        break;
      }
      case "read": {
        var rp = normalizePath(args[0]);
        if (vfs[rp] && vfs[rp].type === "file") {
          var content = vfs[rp].content || "";
          if (Array.isArray(content)) {
            success(new Uint8Array(content).buffer);
          } else {
            success(new TextEncoder().encode(content).buffer);
          }
        } else {
          if (error) error({ code: 1 });
        }
        break;
      }
      case "readAsText": {
        var tp = normalizePath(args[0]);
        if (vfs[tp] && vfs[tp].type === "file") {
          success(vfs[tp].content || "");
        } else {
          if (error) error({ code: 1 });
        }
        break;
      }
      case "write": {
        var wp = normalizePath(args[0]);
        var data = args[1];
        ensureParents(wp);
        var content;
        if (data instanceof ArrayBuffer) {
          content = Array.from(new Uint8Array(data));
        } else if (Array.isArray(data)) {
          content = data;
        } else {
          content = String(data);
        }
        vfs[wp] = { type: "file", content: content, size: content.length, modifiedDate: Date.now() };
        var wdp = dirname(wp);
        if (vfs[wdp] && vfs[wdp].children) vfs[wdp].children[basename(wp)] = true;
        saveVfs();
        success();
        break;
      }
      case "writeText": {
        var wtp = normalizePath(args[0]);
        ensureParents(wtp);
        vfs[wtp] = { type: "file", content: args[1] || "", size: (args[1] || "").length, modifiedDate: Date.now() };
        var wtdp = dirname(wtp);
        if (vfs[wtdp] && vfs[wtdp].children) vfs[wtdp].children[basename(wtp)] = true;
        saveVfs();
        success();
        break;
      }
      case "create file": {
        var cfp = joinPath(normalizePath(args[0]), args[1]);
        ensureParents(cfp);
        vfs[cfp] = { type: "file", content: "", size: 0, modifiedDate: Date.now() };
        var cfdp = normalizePath(args[0]);
        if (vfs[cfdp] && vfs[cfdp].children) vfs[cfdp].children[args[1]] = true;
        saveVfs();
        success(toFileUrl(cfp));
        break;
      }
      case "create directory": {
        var cdp = joinPath(normalizePath(args[0]), args[1]);
        ensureParents(cdp);
        vfs[cdp] = { type: "dir", children: {} };
        var cddp = normalizePath(args[0]);
        if (vfs[cddp] && vfs[cddp].children) vfs[cddp].children[args[1]] = true;
        saveVfs();
        success(toFileUrl(cdp));
        break;
      }
      case "delete": {
        var dp = normalizePath(args[0]);
        delete vfs[dp];
        var ddp = dirname(dp);
        if (vfs[ddp] && vfs[ddp].children) delete vfs[ddp].children[basename(dp)];
        saveVfs();
        success();
        break;
      }
      case "rename": {
        var rp2 = normalizePath(args[0]);
        var newName = args[1];
        var newPath = joinPath(dirname(rp2), newName);
        vfs[newPath] = vfs[rp2];
        delete vfs[rp2];
        var rnp = dirname(rp2);
        if (vfs[rnp] && vfs[rnp].children) {
          delete vfs[rnp].children[basename(rp2)];
          vfs[rnp].children[newName] = true;
        }
        saveVfs();
        success(toFileUrl(newPath));
        break;
      }
      case "list directory": {
        var lp = normalizePath(args[0]);
        if (vfs[lp] && vfs[lp].type === "dir") {
          var entries = [];
          Object.keys(vfs[lp].children).forEach(function (name) {
            var childPath = joinPath(lp, name);
            if (vfs[childPath]) {
              entries.push({
                isFile: vfs[childPath].type === "file",
                isDirectory: vfs[childPath].type === "dir",
                name: name,
                nativeURL: toFileUrl(childPath),
                fullPath: childPath,
              });
            }
          });
          success(entries);
        } else {
          if (error) error({ code: 1 });
        }
        break;
      }
      case "watch file": {
        // No-op; return a fake id
        success(args[1] || "1");
        break;
      }
      case "unwatch file":
        success();
        break;
      case "list volumes":
        success([]);
        break;
      case "list encodings":
        success(["UTF-8", "ASCII", "ISO-8859-1"]);
        break;
      case "copy":
      case "move":
        success();
        break;
      default:
        if (success) success();
    }
  }

  // ─── BuildInfo ───────────────────────────────────────────────────────────

  window.BuildInfo = {
    packageName: "com.foxdebug.acode",
    version: "1.13.5",
    versionCode: "11305",
    debug: true,
    baseDir: toFileUrl(ASSETS_DIR),
    displayName: "Acode",
    installDate: Date.now(),
    buildDate: Date.now(),
  };

  // ─── device ──────────────────────────────────────────────────────────────

  window.device = {
    version: "14",
    platform: "Android",
    model: "Browser",
    manufacturer: "unknown",
    isVirtual: true,
    uuid: "00000000-0000-0000-0000-000000000000",
    cordova: "13.0.0",
  };

  // ─── system (cordova-plugin-system) ──────────────────────────────────────

  window.system = {
    hasPermission: function (permission, success, error) {
      success(true);
    },
    requestPermission: function (permission, success, error) {
      success(true);
    },
    requestPermissions: function (permissions, success, error) {
      success(true);
    },
    getInstaller: function (success, error) {
      success("com.android.vending");
    },
    getAndroidVersion: function (success, error) {
      success(34);
    },
    clearCache: function (success, error) {
      success();
    },
    openInBrowser: function (url, success, error) {
      window.open(url, "_blank");
      if (success) success();
    },
    setIntentHandler: function (handler, onError) {},
    getCordovaIntent: function (success, error) {
      if (success) success(null);
    },
    getGlobalSetting: function (key, success, error) {
      success(1);
    },
    setUiTheme: function (primaryColor, scheme) {},
    setInputType: function (mode) {},
    setNativeContextMenuDisabled: function (disabled) {},
    getWebviewInfo: function (success, error) {
      success({ version: "130.0.0.0", package: "com.google.android.webview" });
    },
    getAppInfo: function (success, error) {
      success({ version: "1.13.5", versionCode: 11305, name: "Acode" });
    },
    getFilesDir: function (success, error) {
      success(toFileUrl(STORAGE_BASE + "/files"));
    },
    getArch: function (success, error) {
      success("arm64");
    },
    setExec: function (path, executable, success, error) {
      if (success) success();
    },
    setAppIcon: function (iconId, success, error) {
      if (success) success();
    },
  };

  // ─── iap (cordova-plugin-iap) ─────────────────────────────────────────────

  window.iap = {
    startConnection: function (success, error) {
      if (success) success();
    },
    endConnection: function (success, error) {
      if (success) success();
    },
    getPurchases: function (success, error) {
      success([]);
    },
    getProducts: function (skus, success, error) {
      success([]);
    },
    purchase: function (sku, success, error) {
      if (error) error({ code: -1, message: "Not available in browser" });
    },
    setPurchaseUpdatedListener: function (listener, error) {},
    acknowledgePurchase: function (token, success, error) {
      if (success) success();
    },
  };

  // ─── sdcard (cordova-plugin-sdcard) ──────────────────────────────────────

  window.sdcard = {
    copy: function (src, dest, success, error) {
      window.cordova.exec(success, error, "SDcard", "copy", [src, dest]);
    },
    createDir: function (pathname, dir, success, error) {
      window.cordova.exec(success, error, "SDcard", "create directory", [pathname, dir]);
    },
    createFile: function (pathname, file, success, error) {
      window.cordova.exec(success, error, "SDcard", "create file", [pathname, file]);
    },
    delete: function (pathname, success, error) {
      window.cordova.exec(success, error, "SDcard", "delete", [pathname]);
    },
    exists: function (pathName, success, error) {
      window.cordova.exec(success, error, "SDcard", "exists", [pathName]);
    },
    formatUri: function (pathName, success, error) {
      success(pathName);
    },
    getPath: function (uri, filename, success, error) {
      success(joinPath(uri, filename));
    },
    getStorageAccessPermission: function (uuid, success, error) {
      success(true);
    },
    listStorages: function (success, error) {
      success([]);
    },
    listDir: function (src, success, error) {
      window.cordova.exec(success, error, "SDcard", "list directory", [src]);
    },
    move: function (src, dest, success, error) {
      window.cordova.exec(success, error, "SDcard", "move", [src, dest]);
    },
    openDocumentFile: function (success, error, mimeType) {
      if (success) success(null);
    },
    getImage: function (success, error, mimeType) {
      if (success) success(null);
    },
    rename: function (pathname, newName, success, error) {
      window.cordova.exec(success, error, "SDcard", "rename", [pathname, newName]);
    },
    read: function (filename, success, error) {
      window.cordova.exec(success, error, "SDcard", "read", [filename]);
    },
    readAsText: function (filename, encoding, success, error) {
      window.cordova.exec(success, error, "SDcard", "readAsText", [filename, encoding]);
    },
    write: function (filename, content, success, error) {
      window.cordova.exec(success, error, "SDcard", "write", [filename, content]);
    },
    writeText: function (filename, content, encoding, success, error) {
      window.cordova.exec(success, error, "SDcard", "writeText", [filename, content, encoding]);
    },
    stats: function (filename, success, error) {
      window.cordova.exec(success, error, "SDcard", "stats", [filename]);
    },
    watchFile: function (filename, listener, onFail) {
      return { unwatch: function () {} };
    },
    listEncodings: function (success, error) {
      window.cordova.exec(success, error, "SDcard", "list encodings", []);
    },
    workspaceScan: function (options, onEvent, onFail) {
      if (onFail) onFail({ message: "Not available in browser" });
    },
    workspaceUpdate: function (options, success, onFail) {
      if (success) success();
    },
    workspaceSearch: function (options, onEvent, onFail) {
      if (onFail) onFail({ message: "Not available in browser" });
    },
    workspaceQuery: function (options, success, onFail) {
      if (success) success([]);
    },
    workspaceCancel: function (id, success, onFail) {
      if (success) success();
    },
    workspaceMarkDirty: function (urls, success, onFail) {
      if (success) success();
    },
    workspaceClear: function (roots, success, onFail) {
      if (success) success();
    },
  };

  // ─── navigator.app ───────────────────────────────────────────────────────

  if (!navigator.app) {
    navigator.app = {};
  }
  navigator.app.overrideButton = function (button, override) {};
  navigator.app.exitApp = function () {};
  navigator.app.loadUrl = function (url) {
    window.location.href = url;
  };
  navigator.app.backHistory = function () {
    window.history.back();
  };

  // ─── Other plugin stubs ───────────────────────────────────────────────────

  // cordova-plugin-clipboard
  window.cordova.plugins = window.cordova.plugins || {};
  window.cordova.plugins.clipboard = {
    copy: function (text, success, error) {
      navigator.clipboard.writeText(text).then(success).catch(error);
    },
    paste: function (success, error) {
      navigator.clipboard.readText().then(success).catch(error);
    },
  };

  // cordova-plugin-browser
  window.cordova.plugins.browser = {
    open: function (url, success, error) {
      window.open(url, "_blank");
      if (success) success();
    },
  };

  // cordova-plugin-advanced-http
  if (!window.cordova.plugin) window.cordova.plugin = {};
  window.cordova.plugin.http = {
    sendRequest: function (url, options, success, error) {
      fetch(url, options).then(function (res) {
        return res.text().then(function (text) {
          success({ status: res.status, data: text, headers: {} });
        });
      }).catch(function (err) {
        if (error) error({ error: err.message });
      });
    },
    get: function (url, params, headers, success, error) {
      fetch(url, { headers: headers || {} }).then(function (res) {
        return res.text().then(function (text) {
          success({ status: res.status, data: text });
        });
      }).catch(function (err) {
        if (error) error({ error: err.message });
      });
    },
    post: function (url, data, headers, success, error) {
      fetch(url, { method: "POST", headers: headers || {}, body: JSON.stringify(data) }).then(function (res) {
        return res.text().then(function (text) {
          success({ status: res.status, data: text });
        });
      }).catch(function (err) {
        if (error) error({ error: err.message });
      });
    },
    setDataSerializer: function () {},
    setCookie: function () {},
    clearCookies: function () {},
  };

  // ─── Fire deviceready ─────────────────────────────────────────────────────

  // In real Cordova, deviceready fires from the native side after the JS
  // bridge is ready — always after the page's scripts have run. main.js is
  // loaded asynchronously by boot.js, so we intercept the deviceready
  // listener registration and fire the event shortly after it's added.
  var devicereadyFired = false;
  var originalAddEventListener = document.addEventListener.bind(document);
  document.addEventListener = function (type, listener, options) {
    if (type === "deviceready" && !devicereadyFired && typeof listener === "function") {
      devicereadyFired = true;
      setTimeout(function () {
        try {
          listener();
        } catch (e) {
          console.error("[cordova-shim] deviceready handler error:", e);
        }
      }, 500);
    }
    return originalAddEventListener(type, listener, options);
  };
})();
