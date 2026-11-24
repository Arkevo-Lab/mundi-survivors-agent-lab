export const DECISION_TIMING_SCHEMA = 'survivors-decision-timing-v1';

export const measured = value => Number.isFinite(value) && value >= 0 ? value : null;
export const elapsed = (start, end) =>
  Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;

export function observationTiming(sample, startedAt, finishedAt) {
  const page = sample?.page_observation_timing;
  const requestedAt = page?.requested_at_ms ?? null;
  const returnedAt = page?.returned_at_ms ?? null;
  return {
    observe_started_at_ms: startedAt,
    observe_finished_at_ms: finishedAt,
    observe_elapsed_ms: elapsed(startedAt, finishedAt),
    requested_at_ms: requestedAt,
    returned_at_ms: returnedAt,
    round_trip_ms: elapsed(requestedAt, returnedAt),
    pre_request_wait_ms: elapsed(startedAt, requestedAt),
    worker: sample?.observation_timing ?? null,
  };
}

export function decisionTiming({ observation, visual, visualStatus, model, modelStatus, action, actionStatus }) {
  const timings = model?.timings;
  const backend = model?.backend_metadata;
  const cachedTokens = model?.usage?.prompt_tokens_details?.cached_tokens ?? model?.usage?.input_tokens_details?.cached_tokens;
  const modelStarted = model?.started_at_ms ?? null;
  const modelFinished = model?.finished_at_ms ?? null;
  const transportStarted = timings?.transport_started_at_ms ?? null;
  const transportFinished = timings?.transport_finished_at_ms ?? null;
  const sentAt = action?.sent_at_ms ?? null;
  const receivedAt = action?.ack?.received_at_ms ?? null;
  const appliedAt = actionStatus === 'applied' ? action.ack.applied_at_ms ?? null : null;
  const tickCompletedAt = actionStatus === 'applied' ? action.ack.tick_completed_at_ms ?? null : null;
  const ackReturnedAt = action?.ack_returned_at_ms ?? null;
  return {
    schema: DECISION_TIMING_SCHEMA,
    observation,
    visual: {
      status: visualStatus,
      ...(visual?.effective_profile && {profile: visual.effective_profile}),
      prepare_started_at_ms: visual?.prepare_started_at_ms ?? null,
      prepare_finished_at_ms: visual?.prepare_finished_at_ms ?? null,
      prepare_elapsed_ms: measured(visual?.prepare_elapsed_ms),
      render_ms: measured(visual?.render_ms),
      encode_ms: measured(visual?.encode_ms),
      validation_ms: measured(visual?.validation_ms),
    },
    model: {
      status: modelStatus,
      started_at_ms: modelStarted,
      finished_at_ms: modelFinished,
      total_ms: elapsed(modelStarted, modelFinished),
      input_prepare_started_at_ms: timings?.input_prepare_started_at_ms ?? null,
      input_prepare_finished_at_ms: timings?.input_prepare_finished_at_ms ?? null,
      input_prepare_ms: measured(timings?.input_prepare_ms),
      input_serialize_started_at_ms: timings?.input_serialize_started_at_ms ?? null,
      input_serialize_finished_at_ms: timings?.input_serialize_finished_at_ms ?? null,
      input_serialize_ms: measured(timings?.input_serialize_ms),
      transport_kind: timings?.transport_kind ?? null,
      transport_started_at_ms: transportStarted,
      transport_finished_at_ms: transportFinished,
      transport_ms: elapsed(transportStarted, transportFinished),
      response_decode_started_at_ms: timings?.response_decode_started_at_ms ?? null,
      response_decode_finished_at_ms: timings?.response_decode_finished_at_ms ?? null,
      response_decode_ms: measured(timings?.response_decode_ms),
      output_parse_started_at_ms: timings?.output_parse_started_at_ms ?? null,
      output_parse_finished_at_ms: timings?.parsed_at_ms ?? null,
      output_parse_ms: measured(timings?.output_parse_ms),
      provider_round_trip_ms: measured(backend?.upstream_round_trip_ms),
      provider_request_prepare_ms: measured(backend?.upstream_request_prepare_ms),
      provider_request_serialize_ms: measured(backend?.upstream_request_serialize_ms),
      provider_response_process_ms: measured(backend?.upstream_response_process_ms),
      provider_inference_ms: null,
      provider_cache_read_tokens: measured(cachedTokens ?? model?.usage?.prompt_cache_hit_tokens),
    },
    action: {
      status: actionStatus,
      sent_at_ms: sentAt,
      worker_received_at_ms: receivedAt,
      applied_at_ms: appliedAt,
      tick_completed_at_ms: tickCompletedAt,
      ack_returned_at_ms: ackReturnedAt,
      page_to_worker_ms: action?.workerClock === 'virtual' ? null : elapsed(sentAt, receivedAt),
      worker_wait_to_apply_ms: elapsed(receivedAt, appliedAt),
      worker_tick_after_apply_ms: elapsed(appliedAt, tickCompletedAt),
      worker_tick_to_ack_ms: action?.workerClock === 'virtual' ? null : elapsed(tickCompletedAt, ackReturnedAt),
      round_trip_ms: elapsed(sentAt, ackReturnedAt),
    },
  };
}
