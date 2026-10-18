#include <iostream>
#include <lcf/lmu/reader.h>
#include <lcf/rpg/map.h>

int main() {
    auto map = lcf::LMU_Reader::Load("Map0002.lmu", "");
    if (!map) return 1;
    for (const auto& ev : map->events) {
        if (ev.ID == 6) {
            std::cout << "Event 6 Pages: " << ev.pages.size() << "\n";
            for (size_t i = 0; i < ev.pages.size(); ++i) {
                std::cout << "Page " << i << " condition switch A: " << ev.pages[i].condition.switch_a_id << "\n";
                for (const auto& cmd : ev.pages[i].event_commands) {
                    std::cout << "  Code: " << cmd.code << "\n";
                }
            }
        }
    }
    return 0;
}
