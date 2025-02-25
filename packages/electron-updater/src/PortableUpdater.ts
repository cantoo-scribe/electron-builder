import { AllPublishOptions } from "builder-util-runtime"
import * as path from "path"
import { AppAdapter } from "./AppAdapter"
import { DownloadUpdateOptions } from "./AppUpdater"
import { BaseUpdater, InstallOptions } from "./BaseUpdater"
import { findFile } from "./providers/Provider"
import { DOWNLOAD_PROGRESS } from "./main"

export class PortableUpdater extends BaseUpdater {
  constructor(options?: AllPublishOptions | null, app?: AppAdapter) {
    super(options, app)
  }

  /*** @private */
  protected doDownloadUpdate(downloadUpdateOptions: DownloadUpdateOptions): Promise<Array<string>> {
    const provider = downloadUpdateOptions.updateInfoAndProvider.provider
    const fileInfo = findFile(provider.resolveFiles(downloadUpdateOptions.updateInfoAndProvider.info), "exe")!

    return this.executeDownload({
      fileExtension: "exe",
      fileInfo,
      downloadUpdateOptions,
      task: async (updateFile, downloadOptions) => {
        if (this.listenerCount(DOWNLOAD_PROGRESS) > 0) {
          downloadOptions.onProgress = it => this.emit(DOWNLOAD_PROGRESS, it)
        }
        await this.httpExecutor.download(fileInfo.url, updateFile, downloadOptions)
      },
    })
  }

  protected doInstall(_: InstallOptions): boolean {
    const installerPath = this.installerPath
    if (installerPath == null) {
      this.dispatchError(new Error("No valid update available, can't quit and install"))
      return false
    }

    // Get current executable path
    const currentExePath = process.execPath
    const appPath = path.dirname(currentExePath)
    const execFileName = path.basename(currentExePath)
    const newExePath = path.join(appPath, `${execFileName}.new`)

    // Copy new version to .new file
    try {
      // Move/copy new executable
      this.spawnSync("cmd", ["/c", "move", "/y", `"${installerPath}"`, `"${newExePath}"`])

      // Create update.cmd batch script to:
      // 1. Wait for original process to exit
      // 2. Replace old exe with new one
      // 3. Start new version
      const updateScript = path.join(appPath, "update.cmd")
      const script = [
        "@echo off",
        "setlocal",
        // Wait for app to close
        `:wait_loop`,
        `tasklist /FI "IMAGENAME eq ${execFileName}" 2>NUL | find /I "${execFileName}" >NUL`,
        `if "%ERRORLEVEL%"=="0" (`,
        `  timeout /t 1 >nul`,
        `  goto :wait_loop`,
        `)`,
        // Replace exe and restart
        `move /y "${newExePath}" "${currentExePath}"`,
        `start "" "${currentExePath}"`,
        "del %~f0",
      ].join("\r\n")

      this.spawnSync("cmd", ["/c", `echo ${script} > "${updateScript}"`])

      // Start update script and exit current app
      this.spawnSync("cmd", ["/c", "start", "/min", "", updateScript])
      this.app.quit()

      return true
    } catch (err) {
      this.dispatchError(err as Error)
      return false
    }
  }

  private spawnSync(command: string, args: string[]) {
    const { execFileSync } = require("child_process")
    execFileSync(command, args, {
      windowsHide: true,
      timeout: 10000,
    })
  }
}
