# Migration Guide for ask-forge-web

## Removing Duplicate Compaction Logic

The core `@nilenso/ask-forge` library now handles context compaction automatically. The web app should remove its duplicate compaction logic and instead listen for compaction events.

### Changes Required in ask-forge-web

#### 1. Update `src/lib/session-logger.ts`

**Remove:**
- Import of `maybeCompact` from `./compaction.ts`
- Import of `getLatestCompaction` from `./db.ts`
- All compaction logic before `session.ask()` (lines 84-125)

**Add:**
- Wrap the `onProgress` callback to intercept `compaction` events
- Persist compaction details to database when event is received

**Before:**
```typescript
import { maybeCompact } from "./compaction.ts";
import {
  createCompaction,
  getLatestCompaction,
  // ...
} from "./db.ts";

async ask(question: string, options?: AskOptions): Promise<AskResult> {
  // ... persist user message ...
  
  // Manual compaction before asking
  try {
    const currentMessages = session.getMessages();
    const messagesWithQuestion = [...currentMessages, newQuestionMessage];
    const previousCompaction = getLatestCompaction(sessionId);
    const compactionResult = await maybeCompact(messagesWithQuestion, previousCompaction?.summary);
    
    if (compactionResult.wasCompacted) {
      session.replaceMessages(compactionResult.messages);
      createCompaction({...});
      options?.onProgress?.({...});
    }
  } catch (compactionError) {
    // ... error handling ...
  }
  
  const result = await session.ask(question, options);
  // ...
}
```

**After:**
```typescript
import {
  createCompaction,
  // NO getLatestCompaction, NO maybeCompact
} from "./db.ts";

async ask(question: string, options?: AskOptions): Promise<AskResult> {
  // ... persist user message ...
  
  // Wrap onProgress to intercept compaction events
  const wrappedOnProgress = options?.onProgress
    ? (event: Parameters<NonNullable<AskOptions["onProgress"]>>[0]) => {
        // Intercept compaction event to persist to database
        if (event.type === "compaction") {
          createCompaction({
            sessionId,
            summary: event.summary,
            firstKeptOrdinal: event.firstKeptOrdinal,
            tokensBefore: event.tokensBefore,
            tokensAfter: event.tokensAfter,
            readFiles: event.readFiles,
            modifiedFiles: event.modifiedFiles,
          });
          console.log(`[compaction] Session ${sessionId} compacted`);
        }
        
        // Forward all events to original callback
        options.onProgress?.(event);
      }
    : undefined;
  
  const result = await session.ask(question, { ...options, onProgress: wrappedOnProgress });
  // ...
}
```

#### 2. Optional: Remove `src/lib/compaction.ts` (if not used elsewhere)

If the web app doesn't use compaction logic elsewhere (e.g., for manual `/compact` commands), you can remove:
- `src/lib/compaction.ts`
- `src/lib/__tests__/compaction.test.ts`

If you do use it for manual compaction, keep the file but the automatic compaction is now handled by the library.

### Benefits of This Change

1. **No Duplicate Logic**: Compaction happens once in the library, not twice
2. **No Double LLM Calls**: Only one summarization request per compaction
3. **Simpler Web Code**: Web just persists results, doesn't manage compaction
4. **Consistent Behavior**: Eval scripts and web use same compaction logic
5. **Easier Maintenance**: Compaction logic in one place (library)

### Testing

After making these changes:

1. Start a new conversation and ask 10+ questions
2. Verify compaction triggers when context exceeds 184K tokens
3. Check database has compaction records
4. Verify UI still shows compaction notifications
5. Ensure conversation continues smoothly after compaction

### Rollout

1. Update `@nilenso/ask-forge` to version with compaction (>= 0.1.0)
2. Apply the changes to `session-logger.ts`
3. Test locally
4. Deploy

### Backward Compatibility

If you need to support both old and new versions of ask-forge temporarily:

```typescript
const wrappedOnProgress = options?.onProgress
  ? (event: any) => {
      if (event.type === "compaction") {
        createCompaction({...});
      }
      options.onProgress?.(event);
    }
  : undefined;

// Keep manual compaction as fallback for older versions
const hasCompactionEvent = /* check if library version supports it */;
if (!hasCompactionEvent) {
  // Old manual compaction logic here
}
```
