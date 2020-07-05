import { join } from "path";
import { commands, ExtensionContext, window } from "vscode";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlink,
  writeFile,
} from "fs";
import {
  AUTO_CHECK,
  ACCOUNT_FILE,
  CACHE_DIR,
  TMP_DIR,
  SETTING_DIR,
  MUSIC_QUALITY,
} from "./constant/setting";
import { LruCacheValue } from "./constant/type";
import { AccountManager } from "./manager/accountManager";
import { ButtonManager } from "./manager/buttonManager";
import {
  PlaylistItemTreeItem,
  PlaylistProvider,
} from "./provider/playlistProvider";
import { QueueProvider, QueueItemTreeItem } from "./provider/queueProvider";
import { apiLike, apiPlaylistTracks } from "./util/api";
import { load } from "./util/util";
import { Cache } from "./util/cache";
import { lock, player } from "./util/player";
import { isLike } from "./state/like";
import { loggedIn } from "./state/login";
import console = require("console");
const del = require("del");
const cacache = require("cacache");

export function activate(context: ExtensionContext): void {
  // read account info from local file
  if (!existsSync(SETTING_DIR)) {
    mkdirSync(SETTING_DIR);
  }
  if (existsSync(ACCOUNT_FILE)) {
    try {
      const { phone, account, password } = JSON.parse(
        readFileSync(ACCOUNT_FILE, "utf8")
      );
      AccountManager.login(phone, account, password).then(() => {
        if (AUTO_CHECK) {
          AccountManager.dailySignin();
        }
      });
    } catch {}
  }

  // init tmp folder
  if (!existsSync(TMP_DIR)) {
    mkdirSync(TMP_DIR);
  }

  // init cache folder
  try {
    const pf = join(SETTING_DIR, "cache");
    const cacheFolders = readdirSync(pf);
    for (const folder of cacheFolders) {
      if (folder !== `${MUSIC_QUALITY}`) {
        const pattern = join(pf, folder);
        del.sync([pattern], { force: true });
      }
    }
  } catch {}

  // init queue provider
  const queueProvider = QueueProvider.getInstance();

  window.registerTreeDataProvider("queue", queueProvider);

  commands.registerCommand("cloudmusic.clearQueue", async () => {
    queueProvider.clear();
    queueProvider.refresh();
    player.quit();
  });
  commands.registerCommand("cloudmusic.randomQueue", () => {
    queueProvider.random();
    queueProvider.refresh();
  });
  commands.registerCommand(
    "cloudmusic.playSong",
    async (element: QueueItemTreeItem) => {
      if (!lock.playerLoad) {
        await load(element);
        queueProvider.top(element);
        queueProvider.refresh();
      }
    }
  );
  commands.registerCommand(
    "cloudmusic.deleteSong",
    async (element: QueueItemTreeItem) => {
      const head = queueProvider.songs[0];
      queueProvider.delete(element);
      queueProvider.refresh();
      if (head === element && !lock.playerLoad) {
        await load(queueProvider.songs[0]);
      }
    }
  );

  // init status bar button
  ButtonManager.init();

  // init player
  player.start().then(() => {
    player.volume(85);
  });

  // sign in command
  const signin = commands.registerCommand("cloudmusic.signin", async () => {
    if (loggedIn.get()) {
      return;
    }
    const method = await window.showQuickPick(
      [
        {
          label: "Email",
          description: "use email to sign in",
          phone: false,
        },
        {
          label: "Cellphone",
          description: "use cellphone to sign in",
          phone: true,
        },
      ],
      {
        placeHolder: "Select the method to sign in.",
      }
    );
    if (!method) {
      return;
    }
    const account = await window.showInputBox({
      placeHolder: "Please enter your account.",
    });
    if (!account) {
      return;
    }
    const password = await window.showInputBox({
      placeHolder: "Please enter your password.",
      password: true,
    });
    if (!password) {
      return;
    }
    if (await AccountManager.login(method.phone, account, password)) {
      writeFile(
        ACCOUNT_FILE,
        JSON.stringify({
          phone: method.phone,
          account,
          password,
        }),
        () => {
          //
        }
      );
      window.showInformationMessage("Sign in success");
    }
  });

  // daily sign in command
  const dailyCheck = commands.registerCommand("cloudmusic.dailyCheck", () => {
    AccountManager.dailySignin();
  });

  // sign out command
  const signout = commands.registerCommand("cloudmusic.signout", async () => {
    if (!loggedIn.get()) {
      return;
    }
    const method = await window.showQuickPick([
      {
        label: AccountManager.nickname,
        description: "current user",
      },
      {
        label: "Sign out",
        description: "",
      },
    ]);
    if (method && method.label === "Sign out") {
      AccountManager.logout();
      try {
        unlink(ACCOUNT_FILE, () => {
          //
        });
      } catch {}
      window.showInformationMessage("Sign out success");
    }
  });

  // previous command
  const previous = commands.registerCommand("cloudmusic.previous", async () => {
    if (!lock.playerLoad && queueProvider.songs) {
      await load(queueProvider.songs[-1]);
      queueProvider.shift(-1);
      queueProvider.refresh();
    }
  });

  // next command
  const next = commands.registerCommand("cloudmusic.next", async () => {
    if (!lock.playerLoad && queueProvider.songs) {
      await load(queueProvider.songs[1]);
      queueProvider.shift(1);
      queueProvider.refresh();
    }
  });

  // play command
  const play = commands.registerCommand("cloudmusic.play", async () => {
    player.togglePlay();
  });

  // like command
  const like = commands.registerCommand("cloudmusic.like", async () => {
    const islike = !isLike.get();
    const id = queueProvider.songs[0].item.id;
    if (await apiLike(id, islike ? "" : "false")) {
      isLike.set(islike);
      islike
        ? AccountManager.likelist.add(id)
        : AccountManager.likelist.delete(id);
    }
  });

  // volume command
  const volume = commands.registerCommand("cloudmusic.volume", async () => {
    const volume = await window.showInputBox({
      placeHolder: "Please enter volume between 0 and 100.",
    });
    if (volume && /^\d+$/.exec(volume)) {
      player.volume(parseInt(volume));
    }
  });

  context.subscriptions.push(signin);
  context.subscriptions.push(dailyCheck);
  context.subscriptions.push(signout);
  context.subscriptions.push(previous);
  context.subscriptions.push(next);
  context.subscriptions.push(play);
  context.subscriptions.push(like);
  context.subscriptions.push(volume);

  // init playlist provider
  const userPlaylistProvider = PlaylistProvider.getUserInstance();
  const favoritePlaylistProvider = PlaylistProvider.getFavoriteInstance();
  window.registerTreeDataProvider("userPlaylist", userPlaylistProvider);
  window.registerTreeDataProvider("favoritePlaylist", favoritePlaylistProvider);

  commands.registerCommand(
    "cloudmusic.refreshPlaylist",
    PlaylistProvider.refresh,
    2048
  );
  commands.registerCommand(
    "cloudmusic.refreshPlaylistContent",
    (element: PlaylistItemTreeItem) => PlaylistProvider.refresh(element)
  );
  commands.registerCommand(
    "cloudmusic.playPlaylist",
    async (element: PlaylistItemTreeItem) => {
      await PlaylistProvider.playPlaylist(element.item.id);
      if (!lock.playerLoad) {
        load(queueProvider.songs[0]);
      }
    }
  );
  commands.registerCommand(
    "cloudmusic.addPlaylist",
    (element: PlaylistItemTreeItem) =>
      PlaylistProvider.addPlaylist(element.item.id)
  );
  commands.registerCommand(
    "cloudmusic.intelligence",
    async (element: QueueItemTreeItem) => {
      await PlaylistProvider.intelligence(element);
      if (!lock.playerLoad) {
        load(element);
      }
    }
  );
  commands.registerCommand("cloudmusic.addSong", (element: QueueItemTreeItem) =>
    PlaylistProvider.addSong(element)
  );
  commands.registerCommand(
    "cloudmusic.playSongWithPlaylist",
    async (element: QueueItemTreeItem) => {
      await PlaylistProvider.playPlaylist(element.pid, element);
      if (!lock.playerLoad) {
        load(element);
      }
    }
  );

  commands.registerCommand(
    "cloudmusic.deleteFromPlaylist",
    async (element: QueueItemTreeItem) => {
      if (await apiPlaylistTracks("del", element.pid, [element.item.id])) {
        PlaylistProvider.refresh();
      }
    }
  );
  commands.registerCommand(
    "cloudmusic.addToPlaylist",
    async (element: QueueItemTreeItem) => {
      const lists = await AccountManager.userPlaylist();
      const selection = await window.showQuickPick(
        lists.map((list) => {
          return {
            label: list.name,
            id: list.id,
          };
        })
      );
      if (!selection) {
        return;
      }
      if (await apiPlaylistTracks("add", selection.id, [element.item.id])) {
        PlaylistProvider.refresh();
      }
    }
  );

  // init cache index
  cacache.ls(CACHE_DIR).then((res: { key: LruCacheValue }) => {
    for (const item in res) {
      const { key, integrity, size } = res[item];
      Cache.lruCache.set(key, { integrity, size });
    }
  });
}

export function deactivate(): void {
  player.quit();
  cacache.verify(CACHE_DIR);
  del.sync([TMP_DIR], { force: true });
}
