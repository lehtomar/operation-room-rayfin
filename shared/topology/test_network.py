import pytest

from shared.topology import RadialNetwork, Segment


def build_sample() -> RadialNetwork:
    #            n0 (substation)
    #             │ A
    #            n1  ── T1 (k0)
    #           B │ ╲ C
    #            n2  n3
    #        T2(k1,k2) │ D
    #                  n4 ── T4 (k3)
    segments = [
        Segment("A", "n0", "n1", "F1"),
        Segment("B", "n1", "n2", "F1"),
        Segment("C", "n1", "n3", "F1"),
        Segment("D", "n3", "n4", "F1"),
    ]
    transformer_nodes = {"T1": "n1", "T2": "n2", "T4": "n4"}
    kp = {"T1": ["k0"], "T2": ["k1", "k2"], "T4": ["k3"]}
    return RadialNetwork(segments, transformer_nodes, kp)


def test_downstream_transformers_root_segment():
    net = build_sample()
    assert net.downstream_transformers("A") == {"T1", "T2", "T4"}


def test_downstream_transformers_branches():
    net = build_sample()
    assert net.downstream_transformers("B") == {"T2"}
    assert net.downstream_transformers("C") == {"T4"}
    assert net.downstream_transformers("D") == {"T4"}


def test_downstream_kayttopaikat():
    net = build_sample()
    assert net.downstream_kayttopaikat("A") == {"k0", "k1", "k2", "k3"}
    assert net.downstream_kayttopaikat("B") == {"k1", "k2"}
    assert net.downstream_kayttopaikat("C") == {"k3"}


def test_affected_by_union_of_simultaneous_faults():
    net = build_sample()
    affected = net.affected_by(["B", "D"])
    assert affected.transformers == {"T2", "T4"}
    assert affected.kayttopaikat == {"k1", "k2", "k3"}
    assert affected.customers_out == 3


def test_closure_counts():
    net = build_sample()
    closure = net.closure()
    assert closure["A"].kayttopaikka_count == 4
    assert closure["A"].transformer_count == 3
    assert closure["C"].kayttopaikka_count == 1
    assert closure["D"].transformer_ids == ["T4"]


def test_non_radial_network_rejected():
    # n2 would be fed by two segments -> not a tree.
    segments = [
        Segment("A", "n0", "n1", "F1"),
        Segment("B", "n1", "n2", "F1"),
        Segment("C", "n0", "n2", "F1"),
    ]
    with pytest.raises(ValueError):
        RadialNetwork(segments, {"T2": "n2"}, {"T2": ["k1"]})
