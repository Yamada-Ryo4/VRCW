/* Instance creation uses a bare world ID; invites use the returned location. */
function instanceCreateBody(worldId, type, region, ownerId) {
  const body = {
    worldId: worldId.split(':')[0],
    type: type === 'invite' || type === 'inviteplus' ? 'private' : type,
    region: region === 'usw' ? 'us' : region,
    ownerId: type === 'public' ? null : ownerId,
  };
  if (type === 'inviteplus') body.canRequestInvite = true;
  return body;
}

function createdInstanceLocation(instance, worldId) {
  const location = instance?.location || instance?.id || instance?.instanceId;
  if (typeof location !== 'string' || !location) throw new Error('Instance response is missing its location');
  return location.includes(':') ? location : `${worldId.split(':')[0]}:${location}`;
}

async function instanceApiError(response, fallback) {
  const body = await response.json().catch(() => null);
  return new Error(body?.error?.message || body?.message
    || (typeof body?.error === 'string' ? body.error : '') || fallback);
}
