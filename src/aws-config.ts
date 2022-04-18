import { homedir } from 'os'
import { join, dirname } from 'path'
import { writeFile, mkdir } from 'fs/promises'
import { createHash } from 'crypto'
import ini from 'ini'
import log from 'electron-log'
import { UserConfig } from "./config"
import { Profile } from './profiles'

async function awsConfigPath(filename: string): Promise<string> {
    const fullPath = join(homedir(), '.aws', filename)
    await mkdir(dirname(fullPath), { recursive: true })
    return fullPath
}

export async function writeAwsConfig(profiles: Profile[]) {
    const fullpath = await awsConfigPath('config')
    log.info('[writeAwsConfig] Writing %s', fullpath)
    const parts = []
    for (const profile of profiles) {
        parts.push(ini.stringify(profile.contents, {
            section: `profile ${profile.name}`,
            whitespace: true,
        }))
    }
    await writeFile(fullpath, parts.join('\n\n'))
}

export async function writeSsoConfig(userConfig: UserConfig, accessToken: string, expiresAt: string) {
    const hash = createHash('sha1')
    hash.update(userConfig.startUrl!)
    const filename = `${hash.digest('hex')}.json`
    const fullpath = await awsConfigPath(join('sso', 'cache', filename))
    log.info('[writeSsoConfig] Writing %s', fullpath)
    const contents = {
        startUrl: userConfig.startUrl,
        region: userConfig.region,
        accessToken,
        expiresAt,
    }
    await writeFile(fullpath, JSON.stringify(contents))
}
