// Personal computer API mapped to OpenMuse's ComputerService. The copied provider
// implementation retains its MIT notice in personalComputer/computer.ts.
import { z } from 'openmuse-zod';
import {ComputerService,computerCommandSchema,computerPathSchema,computerWriteSchema} from './personalComputer/computer';
import {PersonalAgentFileService} from './personalAgentFiles';
import {AppError} from './personalComputer/errors';
export const PERSONAL_COMPUTER_API_PATH='/api/code-agent/room-context/personal-computer';
export class PersonalAgentComputerService {
  constructor(readonly computer:ComputerService,private readonly files:PersonalAgentFileService){}
  async read(clientId:string,input:Record<string,unknown>){
    switch(input.operation ?? 'status'){
      case 'status':return this.computer.snapshot(clientId);
      case 'list':return this.computer.list(clientId,input.path===undefined?undefined:computerPathSchema.parse(input).path);
      case 'read':return this.computer.read(clientId,computerPathSchema.parse(input).path);
      case 'desktop-url':return this.computer.desktopUrl(clientId);
      case 'screenshot':{
        const shot=await this.computer.latestScreenshot(clientId,typeof input.receiptId==='string'?input.receiptId:undefined);
        return {mimeType:shot.mimeType,data:shot.bytes.toString('base64')};
      }
      default:throw new RangeError('Unknown computer read operation');
    }
  }
  async write(clientId:string,input:Record<string,unknown>,options:{scope?:string;signal?:AbortSignal;claim?:{roomId:string;turnId:string}}={}){
    switch(input.operation){
      case 'start':return this.computer.start(clientId);
      case 'stop':return this.computer.stop(clientId);
      case 'run':return this.computer.execute(clientId,computerCommandSchema.parse(input),{idempotencyKey:`${options.scope || 'user'}:${z.string().min(1).max(120).parse(input.operationId)}`,signal:options.signal});
      case 'write':{const value=computerWriteSchema.parse(input);return this.computer.write(clientId,value.path,value.text);}
      case 'mkdir':return this.computer.mkdir(clientId,computerPathSchema.parse(input).path);
      case 'copy-document':{
        const value=z.object({fileId:z.string().uuid(),path:z.string()}).parse(input);
        const file=await this.files.get(clientId,value.fileId);
        return this.computer.writePdf(clientId,value.path,file.body);
      }
      case 'import-pdf':{
        const {name,bytes}=await this.computer.pdfBytes(clientId,computerPathSchema.parse(input).path);
        return this.files.import(clientId,name,bytes,`Computer: ${input.path}`,undefined,options.claim);
      }
      case 'desktop':return this.computer.desktopAction(clientId,input.action,{idempotencyKey:`${options.scope || 'user'}:${z.string().min(1).max(120).parse(input.operationId)}`});
      default:throw new RangeError('Unknown computer write operation');
    }
  }
}
export {AppError as PersonalComputerError};
