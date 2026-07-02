"""Radial distribution-network topology.

This is the *one* place downstream traversal is implemented. gridgen uses it to
pre-compute segment -> downstream closures; the simulator consumes those
closures for correct affected-counts, and the frontend consumes them to
highlight de-energized assets on a fault.

The model is a radial (tree) network rooted at a primary substation:

    substation ──seg──▶ junction ──seg──▶ transformer ──serves──▶ käyttöpaikat

Every feeder *segment* is a directed edge oriented **away** from the substation:
``from_node`` is upstream (towards the source), ``to_node`` is downstream. A
fault on a segment de-energizes everything in the subtree rooted at ``to_node``.
Because the network is radial, each transformer/käyttöpaikka has exactly one
feed path, so the downstream set is well-defined.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Set


@dataclass(frozen=True)
class Segment:
    id: str
    from_node: str  # upstream (towards substation)
    to_node: str  # downstream
    feeder_id: str


class RadialNetwork:
    """A radial feeder network supporting downstream traversal.

    Parameters
    ----------
    segments:
        Directed edges oriented away from the substation.
    transformer_nodes:
        ``transformer_id -> node_id`` (the node a transformer hangs off).
    kayttopaikat_by_transformer:
        ``transformer_id -> list of käyttöpaikka ids``.
    """

    def __init__(
        self,
        segments: Iterable[Segment],
        transformer_nodes: Dict[str, str],
        kayttopaikat_by_transformer: Dict[str, List[str]] | None = None,
    ) -> None:
        self.segments: Dict[str, Segment] = {s.id: s for s in segments}
        self.transformer_nodes = dict(transformer_nodes)
        self.kayttopaikat_by_transformer = {
            tid: list(kps)
            for tid, kps in (kayttopaikat_by_transformer or {}).items()
        }

        # node -> child segment ids (segments leaving that node going downstream)
        self._child_segments: Dict[str, List[str]] = defaultdict(list)
        for s in self.segments.values():
            self._child_segments[s.from_node].append(s.id)

        # node -> transformers attached there
        self._transformers_at: Dict[str, List[str]] = defaultdict(list)
        for tid, node in self.transformer_nodes.items():
            self._transformers_at[node].append(tid)

        self._validate()

    def _validate(self) -> None:
        # Each node must have at most one incoming segment (radial => tree).
        incoming: Dict[str, int] = defaultdict(int)
        for s in self.segments.values():
            incoming[s.to_node] += 1
        multi = [n for n, c in incoming.items() if c > 1]
        if multi:
            raise ValueError(
                f"Network is not radial: nodes with >1 feed: {multi[:5]}"
            )

    # -- traversal --------------------------------------------------------
    def _subtree_nodes(self, root_node: str) -> Set[str]:
        """All nodes at/below ``root_node`` (inclusive)."""
        seen: Set[str] = set()
        stack = [root_node]
        while stack:
            node = stack.pop()
            if node in seen:
                continue
            seen.add(node)
            for seg_id in self._child_segments.get(node, ()):
                stack.append(self.segments[seg_id].to_node)
        return seen

    def downstream_transformers(self, segment_id: str) -> Set[str]:
        """Transformers de-energized by a fault on ``segment_id``."""
        seg = self.segments[segment_id]
        nodes = self._subtree_nodes(seg.to_node)
        result: Set[str] = set()
        for node in nodes:
            result.update(self._transformers_at.get(node, ()))
        return result

    def downstream_kayttopaikat(self, segment_id: str) -> Set[str]:
        """Käyttöpaikat de-energized by a fault on ``segment_id``."""
        result: Set[str] = set()
        for tid in self.downstream_transformers(segment_id):
            result.update(self.kayttopaikat_by_transformer.get(tid, ()))
        return result

    def affected_by(self, faulted_segment_ids: Iterable[str]) -> "AffectedSet":
        """Union of downstream assets across simultaneous faults.

        Radial network: a downstream asset stays out if *any* upstream segment
        on its single feed path is faulted, so a plain union is correct.
        """
        transformers: Set[str] = set()
        kayttopaikat: Set[str] = set()
        for seg_id in faulted_segment_ids:
            transformers |= self.downstream_transformers(seg_id)
            kayttopaikat |= self.downstream_kayttopaikat(seg_id)
        return AffectedSet(transformers=transformers, kayttopaikat=kayttopaikat)

    def closure(self) -> Dict[str, "SegmentClosure"]:
        """Pre-compute downstream closure for every segment."""
        out: Dict[str, SegmentClosure] = {}
        for seg_id in self.segments:
            trs = self.downstream_transformers(seg_id)
            kps = self.downstream_kayttopaikat(seg_id)
            out[seg_id] = SegmentClosure(
                segment_id=seg_id,
                transformer_ids=sorted(trs),
                kayttopaikka_ids=sorted(kps),
            )
        return out


@dataclass
class AffectedSet:
    transformers: Set[str] = field(default_factory=set)
    kayttopaikat: Set[str] = field(default_factory=set)

    @property
    def customers_out(self) -> int:
        return len(self.kayttopaikat)


@dataclass
class SegmentClosure:
    segment_id: str
    transformer_ids: List[str]
    kayttopaikka_ids: List[str]

    @property
    def transformer_count(self) -> int:
        return len(self.transformer_ids)

    @property
    def kayttopaikka_count(self) -> int:
        return len(self.kayttopaikka_ids)
