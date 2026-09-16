import { copyFile, symlink } from 'node:fs/promises'
import { arch } from 'node:os'
import { exit } from 'node:process'
import { execa } from 'execa'

async function main() {
  await symlink(
    '/workspace/packages/autorio/dist',
    '/opt/factorio/data/autorio',
  )
  console.log('Symlinked autorio/dist to /opt/factorio/data/autorio')

  await copyFile(
    'packages/agent/.env.example',
    'packages/agent/.env.local',
  )

  console.log('Copied agent/.env.example to agent/.env.local')
  console.log('Creating save file...\n\n===== Game output starts =====\n')

  if (arch() === 'arm64') {
    await execa('box64', ['/opt/factorio/bin/x64/factorio', '--create', '/opt/factorio/the-save-file.zip'], { stdio: 'inherit' })
  }
  else {
    await execa('/opt/factorio/bin/x64/factorio', ['--create', '/opt/factorio/the-save-file.zip'], { stdio: 'inherit' })
  }

  console.log('\n\n===== Game output ends =====\n\nCreated save file')
}

main().catch((e) => {
  console.error(e)
  exit(1)
})
