import { WorkflowService } from './service';

/**
 * The background's one workflow service. Other streams reach workflows through it, e.g. the Inbox answering
 * an approval (`workflowService.answerRequest(item.approval.requestId, approved)`) or firing an event
 * trigger (`workflowService.fireEvent('inbox_item', item.id, item.source)`).
 */
export const workflowService = new WorkflowService();
