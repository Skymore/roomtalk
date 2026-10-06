export type ComputerProvider='docker'|'e2b-desktop';
export interface Config {publicUrl:string;computerEnabled?:boolean;computerImage?:string;computerDeploymentId?:string;computerProvider?:ComputerProvider;computerE2bTemplate?:string;e2bApiKey?:string;}
export function personalComputerConfig():Config {
  const computerProvider=process.env.COMPUTER_PROVIDER?.trim() || 'docker';
  if(computerProvider!=='docker' && computerProvider!=='e2b-desktop')throw new Error('COMPUTER_PROVIDER must be docker or e2b-desktop');
  const computerEnabled=process.env.COMPUTER_ENABLED==='true',e2bApiKey=process.env.E2B_API_KEY?.trim(),computerDeploymentId=process.env.COMPUTER_DEPLOYMENT_ID?.trim();
  if(computerEnabled && computerProvider==='e2b-desktop' && (!e2bApiKey || !computerDeploymentId))throw new Error('E2B personal computers need E2B_API_KEY and a unique COMPUTER_DEPLOYMENT_ID');
  return {publicUrl:process.env.CLIENT_URL || 'http://localhost:3012',computerProvider,computerEnabled,e2bApiKey,computerDeploymentId,computerImage:process.env.COMPUTER_IMAGE || 'openmuse-computer:local',computerE2bTemplate:process.env.COMPUTER_E2B_TEMPLATE?.trim() || 'desktop'};
}
