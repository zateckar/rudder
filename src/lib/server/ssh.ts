import { execSync } from 'child_process';
import { decrypt, encrypt } from '../server/encryption';
import { db } from '../db';
import { sshKeys } from '../db/schema';
import { v4 as uuid } from 'uuid';
import { eq } from 'drizzle-orm';
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir, platform } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface SSHConnectionConfig {
  host: string;
  port: number;
  username: string;
  privateKey: string;
}

export async function createSSHKey(name: string, privateKey: string, publicKey: string): Promise<string> {
  const id = uuid();
  const encryptedPrivateKey = encrypt(privateKey);
  
  await db.insert(sshKeys).values({
    id,
    name,
    privateKey: encryptedPrivateKey,
    publicKey,
    createdAt: new Date(),
    usedForProvisioning: false,
  });
  
  return id;
}

export async function getSSHKey(id: string): Promise<{ id: string; name: string; privateKey: string; publicKey: string } | null> {
  const key = await db.select().from(sshKeys).where(eq(sshKeys.id, id)).get();
  
  if (!key) return null;
  
  return {
    id: key.id,
    name: key.name,
    privateKey: decrypt(key.privateKey),
    publicKey: key.publicKey,
  };
}

export async function listSSHKeys(): Promise<{ id: string; name: string; publicKey: string; createdAt: Date; usedForProvisioning: boolean }[]> {
  const keys = await db.select().from(sshKeys).all();
  
  return keys.map(key => ({
    id: key.id,
    name: key.name,
    publicKey: key.publicKey,
    createdAt: key.createdAt,
    usedForProvisioning: key.usedForProvisioning,
  }));
}

export function createTempKeyFile(privateKey: string): string {
  const tempPath = join(tmpdir(), `rudder_temp_${Date.now()}.key`);
  writeFileSync(tempPath, privateKey, { mode: 0o600 });
  return platform() === 'win32' ? tempPath.replace(/\\/g, '/') : tempPath;
}

export function deleteTempKeyFile(path: string): void {
  if (existsSync(path)) {
    unlinkSync(path);
  }
}

export async function testSSHConnection(config: SSHConnectionConfig): Promise<boolean> {
  try {
    const tempKeyPath = createTempKeyFile(config.privateKey);
    execSync(
      `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i "${tempKeyPath}" -p ${config.port} ${config.username}@${config.host} echo hello`,
      { encoding: 'utf8', timeout: 15000 }
    );
    deleteTempKeyFile(tempKeyPath);
    return true;
  } catch (error) {
    return false;
  }
}

export async function executeSSHCommand(
  config: SSHConnectionConfig,
  command: string,
  stdinInput?: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const tempKeyPath = createTempKeyFile(config.privateKey);
  try {
    let stdout: string;
    let stderr: string;
    if (stdinInput) {
      // Use stdin for script input
      const result = execSync(
        `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -o ServerAliveInterval=30 -o ServerAliveCountMax=10 -i "${tempKeyPath}" -p ${config.port} ${config.username}@${config.host} ${command}`,
        { encoding: 'utf8', timeout: 300000, input: stdinInput }
      );
      stdout = result;
      stderr = '';
    } else {
      stdout = execSync(
        `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=30 -i "${tempKeyPath}" -p ${config.port} ${config.username}@${config.host} "${command.replace(/"/g, '\\"')}"`,
        { encoding: 'utf8', timeout: 120000 }
      );
      stderr = '';
    }
    deleteTempKeyFile(tempKeyPath);
    return { stdout, stderr, exitCode: 0 };
  } catch (error: any) {
    deleteTempKeyFile(tempKeyPath);
    const errMsg = error.message || '';
    const stderrOutput = error.stderr ? error.stderr.toString() : '';
    return {
      stdout: error.stdout ? error.stdout.toString() : '',
      stderr: stderrOutput || errMsg,
      exitCode: error.status || 1
    };
  }
}
