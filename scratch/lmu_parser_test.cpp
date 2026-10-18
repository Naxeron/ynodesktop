// Tests command extraction using liblcf types, without inventing an LMU parser.
#define main lmu_parser_program_main
#include "lmu_parser.cpp"
#undef main
#include <cassert>
#include <sstream>

lcf::rpg::EventCommand command(lcf::rpg::EventCommand::Code code, std::initializer_list<int> parameters, int indent = 0) {
    lcf::rpg::EventCommand result;
    result.code = static_cast<int>(code);
    result.parameters = parameters;
    result.indent = indent;
    return result;
}

int main() {
    lcf::rpg::Map map;
    lcf::rpg::Chipset chipset;
    map.width = 7;
    map.height = 1;
    map.lower_layer = {5000, 5000, 5000, 4020, 4024, 3000, 2000};
    map.upper_layer = {10000, 10001, 10002, 10000, 10000, 10000, 10000};
    chipset.passable_data_lower[18] = Passable::Left | Passable::Right;
    chipset.passable_data_lower[6] = Passable::Wall;
    chipset.passable_data_lower[3] = Passable::Up;
    chipset.passable_data_lower[2] = Passable::Down;
    chipset.passable_data_upper[0] = Passable::Above | 0x0f;
    chipset.passable_data_upper[1] = Passable::Up | Passable::Down;
    chipset.passable_data_upper[2] = Passable::Above | Passable::Right;
    std::vector<unsigned char> passages;
    assert(navigation_passages(map, chipset, passages));
    // Upper tiles can replace or restrict the lower tile; wall autotile shape matters.
    assert((passages == std::vector<unsigned char>{6, 9, 4, 15, 0, 8, 1}));
    chipset.passable_data_lower.clear();
    chipset.passable_data_upper.clear();
    assert(navigation_passages(map, chipset, passages));
    assert(passages == std::vector<unsigned char>(7, 15));
    map.upper_layer[0] = 9999;
    assert(!navigation_passages(map, chipset, passages));
    map.upper_layer[0] = 10000;
    map.lower_layer[0] = 3999;
    assert(!navigation_passages(map, chipset, passages));
    map.lower_layer[0] = 5000;
    map.generator_flag = true;
    assert(!navigation_passages(map, chipset, passages));
    map.generator_flag = false;
    map.width = 8;
    assert(!navigation_passages(map, chipset, passages));
    map.width = 0;
    assert(!navigation_passages(map, chipset, passages));

    using Code = lcf::rpg::EventCommand::Code;
    std::unordered_map<int, std::vector<lcf::rpg::EventCommand>> common_events;
    common_events[41] = { command(Code::Teleport, {10, 9, 27}), command(Code::CallEvent, {0, 42, 0}) };
    common_events[42] = { command(Code::CallEvent, {0, 41, 0}) };
    const auto extract = [&](const std::vector<lcf::rpg::EventCommand>& commands) {
        std::ostringstream output;
        auto* previous = std::cout.rdbuf(output.rdbuf());
        bool first = true;
        std::unordered_set<int> visited;
        check_commands(commands, 3, 4, common_events, first, visited);
        std::cout.rdbuf(previous);
        return output.str();
    };
    const std::string expected = "    { \"targetMapId\": 10, \"startX\": 3, \"startY\": 4, \"targetX\": 9, \"targetY\": 27 }";
    if (extract({command(Code::CallEvent, {0, 41, 0})}) != expected) {
        std::cerr << "Literal common event extraction or cycle handling failed\n";
        return 1;
    }
    if (extract({command(Code::Teleport, {10, 9, 27})}) != expected) {
        std::cerr << "Direct teleport extraction failed\n";
        return 1;
    }
    // Vehicle commands, variable-based calls, map-event calls and malformed
    // commands must not be mistaken for literal common-event references.
    if (!extract({
        command(Code::EnterExitVehicle, {41}),
        command(Code::CallEvent, {1, 41, 0}),
        command(Code::CallEvent, {2, 41, 0}),
        command(Code::CallEvent, {3, 41, 0}),
        command(Code::CallEvent, {4, 41, 0}),
        command(Code::CallEvent, {0, 41}),
        command(Code::CallEvent, {0, 99999, 0}),
        command(Code::Teleport, {10, 9})
    }).empty()) {
        std::cerr << "Unsupported or malformed commands produced false teleports\n";
        return 1;
    }
    const auto interaction = [&](const std::vector<lcf::rpg::EventCommand>& commands) {
        std::unordered_set<int> visited;
        return exit_interaction(commands, common_events, visited);
    };
    common_events[43] = {command(Code::Teleport, {20, 1, 2}), command(Code::Teleport, {20, 1, 2})};
    common_events[44] = {command(Code::ConditionalBranch, {6, 10001, 0, 0, 0, 0})};
    const auto literal = interaction({command(Code::CallEvent, {0, 43, 0})});
    assert(literal.target_map_ids == std::vector<int>{20});
    assert(!literal.unsupported);
    const auto cosmetic = interaction({command(Code::CallEvent, {0, 44, 0}), command(Code::Teleport, {20, 1, 2})});
    assert(!cosmetic.unsupported); // A direction check in unrelated cleanup does not constrain this transfer.
    for (int direction = 0; direction <= 3; ++direction) {
        const auto guarded = interaction({command(Code::ConditionalBranch, {6, 10001, direction, 0, 0, 0}),
            command(Code::Teleport, {20, 1, 2}, 1), command(Code::EndBranch, {})});
        assert(!guarded.unsupported && guarded.direction == direction);
    }
    const auto up = command(Code::ConditionalBranch, {6, 10001, 0, 0, 0, 1});
    const auto transfer = command(Code::Teleport, {20, 1, 2}, 1);
    const auto nested = interaction({up, command(Code::ConditionalBranch, {0, 1, 0, 0, 0, 0}, 1),
        command(Code::Teleport, {20, 1, 2}, 2), command(Code::EndBranch, {}, 1), command(Code::EndBranch, {})});
    assert(!nested.unsupported && nested.direction == 0);
    assert(interaction({up, transfer, command(Code::ElseBranch, {}), transfer, command(Code::EndBranch, {})}).unsupported);
    assert(interaction({up, command(Code::ElseBranch, {}), transfer, command(Code::EndBranch, {})}).unsupported);
    assert(interaction({up, transfer, command(Code::EndBranch, {}), command(Code::Teleport, {20, 1, 2})}).unsupported);
    const auto unrelated = interaction({up, command(Code::EndBranch, {}), command(Code::Teleport, {20, 1, 2})});
    assert(!unrelated.unsupported && unrelated.direction == -1);
    assert(interaction({up, transfer, command(Code::EndBranch, {}),
        command(Code::ConditionalBranch, {6, 10001, 2, 0, 0, 0}), transfer, command(Code::EndBranch, {})}).unsupported);
    assert(interaction({up, command(Code::ConditionalBranch, {6, 10001, 2, 0, 0, 0}, 1),
        command(Code::Teleport, {20, 1, 2}, 2), command(Code::EndBranch, {}, 1), command(Code::EndBranch, {})}).unsupported);
    assert(interaction({command(Code::ConditionalBranch, {6, 1, 0, 0, 0, 0}), transfer, command(Code::EndBranch, {})}).unsupported);
    const auto common_guarded = interaction({up, command(Code::CallEvent, {0, 43, 0}, 1), command(Code::EndBranch, {})});
    assert(!common_guarded.unsupported && common_guarded.direction == 0);
    common_events[45] = {command(Code::ConditionalBranch, {6, 10001, 2, 0, 0, 0}), transfer, command(Code::EndBranch, {})};
    assert(interaction({up, command(Code::CallEvent, {0, 45, 0}, 1), command(Code::EndBranch, {})}).unsupported);
    assert(interaction({up, command(Code::JumpToLabel, {1}, 1), transfer, command(Code::EndBranch, {})}).unsupported);
    assert(interaction({command(Code::RecallToLocation, {1, 2, 3})}).unsupported);
    assert(interaction({command(Code::CallEvent, {1, 43, 0})}).unsupported);
    assert(interaction({command(Code::CallEvent, {0, 99999, 0})}).unsupported);
    assert(interaction({command(Code::CallEvent, {0, 41, 0})}).unsupported);
    assert(interaction({command(Code::Teleport, {20, 1})}).unsupported);

    lcf::rpg::Event event;
    event.ID = 17;
    event.x = 21;
    event.y = 33;
    lcf::rpg::EventPage page;
    page.trigger = 0;
    page.layer = 1;
    page.event_commands = {command(Code::Teleport, {2001, 52, 45})};
    event.pages.push_back(page);
    page.trigger = 1;
    page.layer = 0;
    event.pages.push_back(page);
    page.trigger = 4;
    page.event_commands.clear();
    event.pages.push_back(page);
    map.events = {event};
    std::ostringstream metadata;
    auto* previous = std::cout.rdbuf(metadata.rdbuf());
    print_exit_interactions(map, common_events);
    std::cout.rdbuf(previous);
    // Mixed action/touch pages and a page without a transfer must remain visible to the consumer.
    assert(metadata.str() == ",\n  \"exitInteractions\": [{\"eventId\":17,\"startX\":21,\"startY\":33,\"pages\":["
        "{\"trigger\":0,\"layer\":1,\"targetMapIds\":[2001],\"unsupported\":false},"
        "{\"trigger\":1,\"layer\":0,\"targetMapIds\":[2001],\"unsupported\":false},"
        "{\"trigger\":4,\"layer\":0,\"targetMapIds\":[],\"unsupported\":false}]}]");
    map.events[0].pages.resize(1);
    map.events[0].pages[0].event_commands = {up, transfer, command(Code::EndBranch, {})};
    metadata.str("");
    previous = std::cout.rdbuf(metadata.rdbuf());
    print_exit_interactions(map, common_events);
    std::cout.rdbuf(previous);
    assert(metadata.str().find("\"targetMapIds\":[20],\"unsupported\":false,\"direction\":0") != std::string::npos);
    std::cout << "LMU command and navigation extraction checks passed\n";
    return 0;
}
